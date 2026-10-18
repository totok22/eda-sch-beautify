#!/usr/bin/env python3
"""把 eda-sch-beautify 的发布产物镜像到 CNB（cnb.cool）。

GitHub Actions 在发布后调用 ``sync``，把同一份 ``.eext`` 上传到 CNB 发布；
本地或用 CNB 流水线补做时也可以直接运行。脚本只用标准库，令牌只从环境变量读取。

示例::

    # 同步最新正式发布
    python scripts/cnb_publish.py sync --repo BITFSAE/eda-sch-beautify

    # 补做全部历史发布
    python scripts/cnb_publish.py sync --repo BITFSAE/eda-sch-beautify --all

    # 上传本地已经打好的安装包
    python scripts/cnb_publish.py publish --repo BITFSAE/eda-sch-beautify \
        --tag v0.3.3 --asset extension/dist/eda-sch-beautify_v0.3.3.eext

    # 不携带 GitHub 令牌，检查 CNB 附件能否匿名下载
    python scripts/cnb_publish.py verify --repo BITFSAE/eda-sch-beautify
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Iterable, Sequence

API_BASE = "https://api.cnb.cool"
WEB_BASE = "https://cnb.cool"
GITHUB_REPO = "totok22/eda-sch-beautify"

ACCEPT_API = "application/vnd.cnb.api+json"
ACCEPT_JSON = "application/json"
USER_AGENT = "BITFSAE-eda-sch-beautify-CNB-Mirror/1.0"

# 扩展安装包命名约定：eda-sch-beautify_v0.3.3.eext
ASSET_NAME_PATTERN = "eda-sch-beautify_{tag}.eext"

# CNB 的 ttl 单位是天，0 表示永久（上限 180 天）。
ASSET_TTL_DAYS = 0


class CnbError(RuntimeError):
    """CNB 接口或 GitHub 网络请求失败。"""


def asset_download_url(repo: str, tag: str, filename: str, base: str = WEB_BASE) -> str:
    """发布附件的匿名下载地址（主域名，跟随 302 到临时地址）。"""
    return "{}/{}/-/releases/download/{}/{}".format(
        base.rstrip("/"),
        repo.strip("/"),
        urllib.parse.quote(tag, safe=""),
        urllib.parse.quote(filename, safe=""),
    )


def _text(value: Any) -> str:
    return "" if value is None else str(value)


def normalize_metadata(payload: dict[str, Any]) -> dict[str, Any]:
    """统一 GitHub API 与 ``gh release view --json`` 的字段命名。"""
    if not isinstance(payload, dict):
        raise ValueError("发布元数据不是 JSON 对象")
    tag = _text(payload.get("tag_name") or payload.get("tagName")).strip()
    if not tag:
        raise ValueError("发布元数据缺少 tag_name")
    prerelease = payload.get("prerelease")
    if prerelease is None:
        prerelease = payload.get("isPrerelease")
    return {
        "tag_name": tag,
        "name": _text(payload.get("name")).strip() or tag,
        "body": _text(payload.get("body")),
        "published_at": _text(payload.get("published_at") or payload.get("publishedAt")),
        "prerelease": bool(prerelease),
        "draft": bool(payload.get("draft") or payload.get("isDraft")),
    }


def tag_sort_key(tag: str) -> tuple:
    """按 vX.Y.Z 排序；带后缀的预发布排在对应正式版之后。"""
    value = tag[1:] if tag.startswith(("v", "V")) else tag
    match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)(?:-(.+))?", value)
    if not match:
        return (0, 0, 0, 1, value)
    major, minor, patch = (int(match.group(index)) for index in (1, 2, 3))
    suffix = match.group(4)
    return (major, minor, patch, 0 if suffix is None else 1, suffix or "")


def formal_tags(tags: Iterable[str]) -> list[str]:
    return [tag for tag in tags if re.fullmatch(r"v?\d+\.\d+\.\d+", tag)]


class CnbClient:
    """CNB OpenAPI 的最小客户端（发布与附件上传）。"""

    def __init__(self, repo: str, token: str, timeout: float = 120.0, base: str = API_BASE) -> None:
        self.repo = repo.strip("/")
        self.token = token
        self.timeout = timeout
        self.base = base.rstrip("/")

    def _url(self, path: str) -> str:
        return f"{self.base}/{self.repo}/-/{path.lstrip('/')}"

    def _request(
        self,
        method: str,
        url: str,
        data: bytes | None = None,
        content_type: str | None = None,
        accept: str = ACCEPT_API,
        auth: bool = True,
    ) -> tuple[Any, bytes]:
        headers = {"User-Agent": USER_AGENT, "Accept": accept}
        if auth:
            headers["Authorization"] = f"Bearer {self.token}"
        if content_type:
            headers["Content-Type"] = content_type
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return response, response.read()
        except urllib.error.HTTPError as exc:
            detail = ""
            try:
                detail = exc.read().decode("utf-8", "replace").strip()
            except Exception:  # pragma: no cover - 读取错误体失败不影响报错信息
                pass
            raise CnbError(f"CNB 请求失败 {method} {url} -> HTTP {exc.code} {detail[:400]}") from exc
        except urllib.error.URLError as exc:
            raise CnbError(f"CNB 网络不可达 {method} {url}: {exc.reason}") from exc

    @staticmethod
    def _decode(body: bytes, context: str, required: bool = True) -> Any:
        value = body.decode("utf-8", "replace").strip()
        if not value:
            if required:
                raise CnbError(f"CNB {context} 返回空响应")
            return {}
        try:
            return json.loads(value)
        except ValueError as exc:
            raise CnbError(f"CNB {context} 返回的不是 JSON：{value[:200]!r}") from exc

    def get_release_by_tag(self, tag: str) -> dict[str, Any] | None:
        url = self._url(f"releases/tags/{urllib.parse.quote(tag, safe='')}")
        try:
            _, body = self._request("GET", url)
        except CnbError as exc:
            if "HTTP 404" in str(exc):
                return None
            raise
        payload = self._decode(body, f"发布查询 {tag}")
        return payload if isinstance(payload, dict) else None

    def create_release(self, form: dict[str, Any]) -> dict[str, Any]:
        data = json.dumps(form, ensure_ascii=False).encode("utf-8")
        _, body = self._request("POST", self._url("releases"), data, ACCEPT_JSON)
        payload = self._decode(body, "创建发布")
        if not isinstance(payload, dict) or not payload.get("id"):
            raise CnbError(f"CNB 创建发布返回格式不正确：{body[:300]!r}")
        return payload

    def patch_release(self, release_id: str, form: dict[str, Any]) -> None:
        data = json.dumps(form, ensure_ascii=False).encode("utf-8")
        self._request("PATCH", self._url(f"releases/{release_id}"), data, ACCEPT_JSON)

    def list_releases(self, page_size: int = 100) -> list[dict[str, Any]]:
        url = self._url(f"releases?page=1&page_size={max(1, int(page_size))}")
        _, body = self._request("GET", url)
        payload = self._decode(body, "发布列表")
        if not isinstance(payload, list):
            raise CnbError(f"CNB 发布列表返回格式不正确：{body[:300]!r}")
        return [item for item in payload if isinstance(item, dict)]

    def upload_asset(self, release_id: str, path: Path) -> None:
        """预签名地址上传 + 确认；同名附件覆盖，永久保留。"""
        size = path.stat().st_size
        form = json.dumps(
            {"asset_name": path.name, "size": size, "overwrite": True, "ttl": ASSET_TTL_DAYS},
            ensure_ascii=False,
        ).encode("utf-8")
        _, body = self._request(
            "POST", self._url(f"releases/{release_id}/asset-upload-url"), form, ACCEPT_JSON
        )
        ticket = self._decode(body, "附件上传地址")
        upload_url = _text(ticket.get("upload_url"))
        verify_url = _text(ticket.get("verify_url"))
        if not upload_url or not verify_url:
            raise CnbError(f"CNB 未返回附件上传地址：{body[:300]!r}")
        self._request(
            "PUT",
            upload_url,
            path.read_bytes(),
            "application/octet-stream",
            accept=ACCEPT_JSON,
            auth=False,
        )
        # 确认接口必须带 Accept: application/json，否则 CNB 返回 406。
        self._request("POST", verify_url, b"{}", ACCEPT_JSON, accept=ACCEPT_JSON)


def github_json(url: str, token: str | None = None, timeout: float = 60.0) -> Any:
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", "replace").strip()
        except Exception:  # pragma: no cover
            pass
        raise CnbError(f"GitHub 请求失败 {url} -> HTTP {exc.code} {detail[:200]}") from exc
    except urllib.error.URLError as exc:
        raise CnbError(f"GitHub 网络不可达 {url}: {exc.reason}") from exc


def github_release(repo: str, tag: str | None = None, token: str | None = None,
                   timeout: float = 60.0) -> dict[str, Any]:
    base = f"https://api.github.com/repos/{repo.strip('/')}"
    if tag:
        payload = github_json(f"{base}/releases/tags/{urllib.parse.quote(tag, safe='')}", token, timeout)
        if not isinstance(payload, dict):
            raise CnbError(f"GitHub 发布 {tag} 返回格式不正确")
        return payload
    releases = github_json(f"{base}/releases?per_page=100", token, timeout)
    if not isinstance(releases, list):
        raise CnbError("GitHub 发布列表返回格式不正确")
    for candidate in releases:
        if isinstance(candidate, dict) and not candidate.get("draft") and not candidate.get("prerelease"):
            return candidate
    raise CnbError(f"GitHub 仓库 {repo} 上没有可用的正式发布")


def github_releases(repo: str, token: str | None = None, include_prerelease: bool = False,
                    timeout: float = 60.0) -> list[dict[str, Any]]:
    url = f"https://api.github.com/repos/{repo.strip('/')}/releases?per_page=100"
    payload = github_json(url, token, timeout)
    if not isinstance(payload, list):
        raise CnbError("GitHub 发布列表返回格式不正确")
    return [
        item for item in payload
        if isinstance(item, dict) and not item.get("draft")
        and (include_prerelease or not item.get("prerelease"))
    ]


def github_assets(release: dict[str, Any]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for asset in release.get("assets") or []:
        if not isinstance(asset, dict):
            continue
        name = _text(asset.get("name")).strip()
        url = _text(asset.get("browser_download_url")).strip()
        if not name or not url:
            continue
        result.append({"name": name, "size": int(asset.get("size") or 0), "url": url})
    return result


def mirror_is_current(cnb_release: dict[str, Any] | None, wanted_assets: Sequence[dict[str, Any]]) -> bool:
    """CNB 发布是否已包含待镜像的全部附件（名称与大小都一致）。"""
    if not cnb_release:
        return False
    have = {
        _text(asset.get("name")): int(asset.get("size") or 0)
        for asset in cnb_release.get("assets") or []
        if isinstance(asset, dict)
    }
    want = [(_text(asset.get("name")), int(asset.get("size") or 0)) for asset in wanted_assets]
    return bool(want) and all(have.get(name) == size for name, size in want)


def download_file(url: str, target: Path, token: str | None = None, timeout: float = 600.0) -> None:
    headers = {"User-Agent": USER_AGENT, "Accept": "application/octet-stream"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, headers=headers)
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(target.name + ".part")
    with urllib.request.urlopen(request, timeout=timeout) as response, partial.open("wb") as handle:
        while True:
            chunk = response.read(256 * 1024)
            if not chunk:
                break
            handle.write(chunk)
    partial.replace(target)


def remote_tags(repo: str, timeout: float = 60.0) -> list[str]:
    """用 git ls-remote 取 GitHub 标签，避免 CNB 共享出口 IP 被 GitHub API 限流。"""
    if shutil.which("git") is None:
        raise CnbError("系统中找不到 git，无法读取 GitHub 标签")
    result = subprocess.run(
        ["git", "ls-remote", "--tags", "--refs", f"https://github.com/{repo.strip('/')}"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )
    if result.returncode != 0:
        raise CnbError(f"git ls-remote 失败：{(result.stderr or result.stdout).strip()[:300]}")
    return [
        line.split("\t", 1)[1].removeprefix("refs/tags/")
        for line in result.stdout.splitlines()
        if "\trefs/tags/" in line
    ]


def probe_remote_size(url: str, timeout: float = 60.0) -> int:
    request = urllib.request.Request(url, method="HEAD", headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return int(response.headers.get("Content-Length") or 0)
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return 0
        raise CnbError(f"探测发布附件失败 {url} -> HTTP {exc.code}") from exc
    except urllib.error.URLError as exc:
        raise CnbError(f"探测发布附件网络不可达 {url}: {exc.reason}") from exc


def fallback_release(repo: str, tag: str, timeout: float = 60.0) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """GitHub API 不可用时，按安装包命名约定拼出发布附件。"""
    name = ASSET_NAME_PATTERN.format(tag=tag)
    url = "https://github.com/{}/releases/download/{}/{}".format(
        repo.strip("/"), urllib.parse.quote(tag, safe=""), urllib.parse.quote(name, safe="")
    )
    size = probe_remote_size(url, timeout)
    if size <= 0:
        raise CnbError(f"GitHub 上找不到发布附件 {name}，请确认 {tag} 是否为正式发布")
    metadata = {
        "tag_name": tag,
        "name": tag,
        "body": "",
        "published_at": "",
        "prerelease": "-" in tag,
        "draft": False,
    }
    return metadata, [{"name": name, "size": size, "url": url}]


def release_form(metadata: dict[str, Any], make_latest: bool) -> dict[str, Any]:
    return {
        "tag_name": metadata["tag_name"],
        "target_commitish": metadata["tag_name"],
        "name": metadata["name"],
        "body": metadata["body"],
        "prerelease": bool(metadata["prerelease"]),
        "make_latest": "true" if make_latest else "false",
    }


def ensure_release(client: CnbClient, metadata: dict[str, Any], make_latest: bool) -> dict[str, Any]:
    tag = metadata["tag_name"]
    form = release_form(metadata, make_latest)
    release = client.get_release_by_tag(tag)
    if release is None:
        release = client.create_release(form)
        print(f"创建 CNB 发布 {tag}（id={release.get('id')}）")
        return release
    patch = {key: value for key, value in form.items() if key not in ("tag_name", "target_commitish")}
    client.patch_release(_text(release.get("id")), patch)
    print(f"更新 CNB 发布 {tag}（id={release.get('id')}）")
    return release


def publish_assets(client: CnbClient, release_id: str, assets: Sequence[Path]) -> None:
    for asset in assets:
        client.upload_asset(release_id, asset)
        print(f"上传附件 {asset.name}（{asset.stat().st_size} 字节）")


def verify_anonymous(repo: str, releases: Sequence[dict[str, Any]], timeout: float = 60.0,
                     attempts: int = 3) -> dict[str, Any]:
    """不携带令牌，验证发布附件可以通过 cnb.cool 匿名下载。"""
    results: list[dict[str, Any]] = []
    for release in releases:
        tag = _text(release.get("tag_name"))
        for asset in release.get("assets") or []:
            if not isinstance(asset, dict):
                continue
            name = _text(asset.get("name"))
            if not name:
                continue
            url = asset_download_url(repo, tag, name)
            entry = {"tag": tag, "name": name, "ok": False, "error": ""}
            for attempt in range(max(1, attempts)):
                try:
                    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
                    with urllib.request.urlopen(request, timeout=timeout) as response:
                        entry["ok"] = True
                        entry["size"] = int(response.headers.get("Content-Length") or 0)
                        entry["error"] = ""
                        response.read(1)
                    break
                except Exception as exc:  # pragma: no cover - 网络异常直接回报
                    entry["error"] = str(exc)
                    if attempt + 1 < max(1, attempts):
                        time.sleep(1.0 + attempt)
            results.append(entry)
    return {"releases": len(releases), "assets": results}


def _read_token(env_name: str) -> str:
    token = (os.environ.get(env_name) or "").strip()
    if not token:
        raise CnbError(f"环境变量 {env_name} 中没有 CNB 访问令牌")
    return token


def _latest_tag(candidates: Iterable[str]) -> str:
    tags = formal_tags(candidates)
    return max(tags, key=tag_sort_key) if tags else ""


def _download_assets(remote_assets: Sequence[dict[str, Any]], download_dir: str,
                     github_token: str | None, timeout: float) -> list[Path]:
    work = Path(download_dir) if download_dir else Path(tempfile.mkdtemp(prefix="cnb-sync-"))
    work.mkdir(parents=True, exist_ok=True)
    paths: list[Path] = []
    for asset in remote_assets:
        target = work / asset["name"]
        if target.is_file() and target.stat().st_size == asset["size"]:
            print(f"复用已下载附件 {target.name}")
        else:
            print(f"下载 {asset['name']}（{asset['size']} 字节）")
            download_file(asset["url"], target, github_token, timeout)
        if target.stat().st_size != asset["size"]:
            raise CnbError(
                f"{target.name} 下载不完整：期望 {asset['size']} 字节，实际 {target.stat().st_size} 字节"
            )
        paths.append(target)
    return paths


def sync_one(client: CnbClient, repo: str, metadata: dict[str, Any],
             remote_assets: Sequence[dict[str, Any]], make_latest: bool,
             args: argparse.Namespace) -> str:
    tag = metadata["tag_name"]
    current = client.get_release_by_tag(tag)
    if mirror_is_current(current, remote_assets) and not args.force:
        if not args.dry_run:
            ensure_release(client, metadata, make_latest)
        print(f"CNB 已是最新镜像：{tag}（{len(remote_assets)} 个附件）")
        return "current"
    if args.dry_run:
        print(f"[dry-run] 将镜像发布 {repo} {tag}（{len(remote_assets)} 个附件）")
        for asset in remote_assets:
            print(f"[dry-run]   {asset['name']} ({asset['size']} 字节)")
        return "dry-run"

    paths = _download_assets(remote_assets, args.download_dir, args.github_token, args.timeout)
    release = ensure_release(client, metadata, make_latest)
    release_id = _text(release.get("id"))
    publish_assets(client, release_id, paths)

    refreshed = client.get_release_by_tag(tag) or {}
    uploaded = {_text(item.get("name")) for item in refreshed.get("assets") or [] if isinstance(item, dict)}
    missing = [path.name for path in paths if path.name not in uploaded]
    if missing:
        raise CnbError(f"CNB 发布 {tag} 缺少附件：{', '.join(missing)}")
    return "published"


def _verify_releases(repo: str, client: CnbClient, tags: Sequence[str] | None, timeout: float) -> None:
    releases = client.list_releases(100)
    if tags:
        wanted = set(tags)
        releases = [item for item in releases if _text(item.get("tag_name")) in wanted]
    report = verify_anonymous(repo, releases, timeout)
    bad = [item for item in report["assets"] if not item["ok"]]
    print(f"匿名校验：发布 {report['releases']} 个，附件 {len(report['assets'])} 个，失败 {len(bad)} 个")
    for item in bad:
        print(f"  下载失败 {item['tag']} {item['name']}：{item['error']}")
    if bad:
        raise CnbError("匿名下载校验失败，请检查 CNB 发布附件状态")


def cmd_publish(args: argparse.Namespace) -> int:
    token = _read_token(args.token_env)
    metadata = (
        normalize_metadata(json.loads(Path(args.metadata_json).read_text(encoding="utf-8")))
        if args.metadata_json else {
            "tag_name": args.tag, "name": args.tag, "body": "", "published_at": "",
            "prerelease": bool(args.prerelease), "draft": False,
        }
    )
    if args.prerelease:
        metadata["prerelease"] = True
    assets = [Path(item) for item in args.asset]
    if not assets:
        raise CnbError("至少需要一个 --asset 附件")
    for asset in assets:
        if not asset.is_file():
            raise CnbError(f"待上传附件不存在：{asset}")

    latest = _latest_tag([metadata["tag_name"], *remote_tags(args.github_repo, args.timeout)])
    make_latest = metadata["tag_name"] == latest and not metadata["prerelease"]
    if args.dry_run:
        print(f"[dry-run] 将镜像发布 {args.repo} {metadata['tag_name']}（{len(assets)} 个附件）")
        for asset in assets:
            print(f"[dry-run]   {asset.name} ({asset.stat().st_size} 字节)")
        return 0

    client = CnbClient(args.repo, token, timeout=args.timeout, base=args.api_base)
    release = ensure_release(client, metadata, make_latest)
    publish_assets(client, _text(release.get("id")), assets)
    if not args.skip_verify:
        _verify_releases(args.repo, client, [metadata["tag_name"]], args.timeout)
    return 0


def _collect_sync_items(args: argparse.Namespace, github_token: str | None) -> tuple[list[dict[str, Any]], list[str]]:
    """返回 (发布元数据+附件, 全部标签)。GitHub API 失败时按标签和命名约定兜底。"""
    items: list[dict[str, Any]] = []
    try:
        if args.tag:
            payloads = [github_release(args.github_repo, args.tag, github_token, args.timeout)]
        elif args.all:
            payloads = github_releases(args.github_repo, github_token, args.include_prerelease, args.timeout)
        else:
            payloads = [github_release(args.github_repo, None, github_token, args.timeout)]
        for payload in payloads:
            metadata = normalize_metadata(payload)
            assets = github_assets(payload)
            if not assets:
                raise CnbError(f"GitHub 发布 {metadata['tag_name']} 没有附件")
            items.append({"metadata": metadata, "assets": assets})
    except CnbError as exc:
        print(f"GitHub API 不可用：{exc}")
        print("改用标签与附件名约定探测…")
        if args.tag:
            tags = [args.tag]
        else:
            tags = sorted(formal_tags(remote_tags(args.github_repo, args.timeout)), key=tag_sort_key)
            if not args.all:
                tags = tags[-1:]
        if not tags:
            raise CnbError(f"GitHub 仓库 {args.github_repo} 上没有形如 vX.Y.Z 的标签") from exc
        for tag in tags:
            metadata, assets = fallback_release(args.github_repo, tag, args.timeout)
            if metadata["prerelease"] and not args.include_prerelease and not args.tag:
                continue
            items.append({"metadata": metadata, "assets": assets})

    try:
        tags = remote_tags(args.github_repo, args.timeout)
    except CnbError:
        tags = [item["metadata"]["tag_name"] for item in items]
    return items, formal_tags(tags)


def cmd_sync(args: argparse.Namespace) -> int:
    token = _read_token(args.token_env)
    github_token = (os.environ.get(args.github_token_env) or "").strip() or None
    args.github_token = github_token
    items, all_tags = _collect_sync_items(args, github_token)
    if not items:
        print("没有需要镜像的正式发布")
        return 0
    items.sort(key=lambda item: tag_sort_key(item["metadata"]["tag_name"]))
    latest = _latest_tag([*all_tags, *(item["metadata"]["tag_name"] for item in items)])
    client = CnbClient(args.repo, token, timeout=args.timeout, base=args.api_base)

    counts = {"published": 0, "current": 0, "dry-run": 0}
    mirrored_tags: list[str] = []
    for item in items:
        metadata = item["metadata"]
        make_latest = metadata["tag_name"] == latest and not metadata["prerelease"]
        result = sync_one(client, args.repo, metadata, item["assets"], make_latest, args)
        counts[result] += 1
        mirrored_tags.append(metadata["tag_name"])
    print(
        "镜像完成：新上传 {} 个，已是最新 {} 个，演练 {} 个".format(
            counts["published"], counts["current"], counts["dry-run"]
        )
    )
    if not args.dry_run and not args.skip_verify:
        _verify_releases(args.repo, client, mirrored_tags, args.timeout)
    return 0


def cmd_verify(args: argparse.Namespace) -> int:
    token = _read_token(args.token_env)
    client = CnbClient(args.repo, token, timeout=args.timeout, base=args.api_base)
    releases = client.list_releases(100)
    if args.tag:
        releases = [item for item in releases if _text(item.get("tag_name")) == args.tag]
    if not releases:
        raise CnbError(f"CNB 仓库 {args.repo} 上没有匹配的发布")
    report = verify_anonymous(args.repo, releases, args.timeout)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 1 if any(not item["ok"] for item in report["assets"]) else 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="eda-sch-beautify 的 CNB 发布镜像工具")
    sub = parser.add_subparsers(dest="command", required=True)

    def common(target: argparse.ArgumentParser) -> None:
        target.add_argument("--repo", default="BITFSAE/eda-sch-beautify", help="CNB 仓库，格式 组织/仓库")
        target.add_argument("--github-repo", default=GITHUB_REPO, help="来源 GitHub 仓库")
        target.add_argument("--token-env", default="CNB_TOKEN", help="保存 CNB 访问令牌的环境变量名")
        target.add_argument("--api-base", default=API_BASE)
        target.add_argument("--web-base", default=WEB_BASE)
        target.add_argument("--timeout", type=float, default=120.0)
        target.add_argument("--skip-verify", action="store_true", help="跳过匿名下载校验")
        target.add_argument("--dry-run", action="store_true")

    publish = sub.add_parser("publish", help="把本地已有的安装包上传到 CNB")
    common(publish)
    publish.add_argument("--tag", required=True, help="发布标签，例如 v0.3.3")
    publish.add_argument("--asset", action="append", default=[], help="要上传的附件路径，可重复")
    publish.add_argument("--metadata-json", default="", help="GitHub 发布元数据 JSON（gh release view）")
    publish.add_argument("--prerelease", action="store_true", help="标记为预发布")
    publish.set_defaults(func=cmd_publish)

    sync = sub.add_parser("sync", help="从 GitHub 拉取发布产物并镜像到 CNB")
    common(sync)
    scope = sync.add_mutually_exclusive_group()
    scope.add_argument("--tag", default="", help="指定发布标签；留空取最新正式发布")
    scope.add_argument("--all", action="store_true", help="镜像全部正式发布")
    sync.add_argument("--include-prerelease", action="store_true", help="包含预发布")
    sync.add_argument("--download-dir", default="", help="附件下载目录；留空用临时目录")
    sync.add_argument("--github-token-env", default="GITHUB_TOKEN", help="可选的 GitHub 令牌环境变量名")
    sync.add_argument("--force", action="store_true", help="即使已是最新镜像也重新上传")
    sync.set_defaults(func=cmd_sync)

    verify = sub.add_parser("verify", help="匿名校验 CNB 发布附件下载")
    verify.add_argument("--repo", default="BITFSAE/eda-sch-beautify")
    verify.add_argument("--tag", default="")
    verify.add_argument("--token-env", default="CNB_TOKEN")
    verify.add_argument("--api-base", default=API_BASE)
    verify.add_argument("--timeout", type=float, default=60.0)
    verify.set_defaults(func=cmd_verify)
    return parser


def _configure_stdout() -> None:
    stream = getattr(sys, "stdout", None)
    reconfigure = getattr(stream, "reconfigure", None)
    if reconfigure is None:
        return
    try:
        reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # pragma: no cover
        pass


def main(argv: list[str] | None = None) -> int:
    _configure_stdout()
    args = build_parser().parse_args(argv)
    try:
        return int(args.func(args))
    except CnbError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 2
    except Exception as exc:  # noqa: BLE001 - 顶层统一兜底，CI 需要非零退出码
        print(f"错误：{exc}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
