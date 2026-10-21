"""Configure the Git-integrated Pages project using Wrangler's OAuth login.

Run with:
    uv run python scripts/cloudflare-project.py --account ACCOUNT_ID \\
        --repo OWNER/REPO --bot-api-url https://bot.example.com create

Secrets are loaded from private files and never printed or passed in argv.
Production and preview environment variables are set from the CLI arguments and
the local .env API_TOKEN; nothing in this script contains a live endpoint.
BOT_API_URL and BOT_API_TOKEN are both created as encrypted secret bindings.
The URL is not a credential, but keeping it out of plaintext Wrangler vars stops
a tracked wrangler.toml from overwriting the deployment-specific origin.
"""

import argparse
import json
import re
import subprocess
import tomllib
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PROJECT = "zorr-mob-notifier"


def project_name(value):
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", value):
        raise argparse.ArgumentTypeError(
            "project names use lowercase letters, digits, and hyphens"
        )
    return value


def repository(value):
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", value):
        raise argparse.ArgumentTypeError("expected OWNER/NAME")
    return value


def https_origin(value):
    try:
        parsed = urlparse(value)
        _ = parsed.port  # Raises ValueError for a malformed or out-of-range port.
    except ValueError:
        raise argparse.ArgumentTypeError(
            "expected an HTTPS origin such as https://bot.example.com"
        ) from None
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or not parsed.hostname.isascii()
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or parsed.path not in ("", "/")
    ):
        raise argparse.ArgumentTypeError(
            "expected an HTTPS origin such as https://bot.example.com"
        )
    return value.rstrip("/")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--account", required=True)
    parser.add_argument("--project", type=project_name, default=DEFAULT_PROJECT)
    parser.add_argument("--repo", type=repository)
    parser.add_argument("--bot-api-url", type=https_origin)
    parser.add_argument("action", choices=["inspect", "create", "status", "retry", "logs"])
    parser.add_argument("--deployment")
    args = parser.parse_args()
    if args.action == "create" and not args.repo:
        parser.error("--repo OWNER/REPO is required for create")
    if args.action == "create" and not args.bot_api_url:
        parser.error("--bot-api-url is required for create")

    config = tomllib.loads((Path.home() / ".config/.wrangler/config/default.toml").read_text())
    token = config["oauth_token"]

    def cf(path, method="GET", body=None):
        request = Request("https://api.cloudflare.com/client/v4" + path,
                          data=json.dumps(body).encode() if body is not None else None,
                          headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"}, method=method)
        try:
            with urlopen(request, timeout=40) as response:
                payload = json.load(response)
        except HTTPError as error:
            payload = json.loads(error.read())
        if not payload.get("success"):
            raise RuntimeError(json.dumps(payload.get("errors", [])))
        return payload["result"]

    base = f"/accounts/{args.account}/pages/projects"
    if args.action == "create":
        owner, repo_name = args.repo.split("/", 1)
        existing = next((p for p in cf(base) if p["name"] == args.project), None)
        if existing:
            source = existing.get("source", {}).get("config", {})
            same_repo = (
                str(source.get("owner", "")).lower() == owner.lower()
                and str(source.get("repo_name", "")).lower() == repo_name.lower()
            )
            if not same_repo:
                raise RuntimeError(
                    "A different or Direct Upload project already uses this name; "
                    "refusing to replace it"
                )
            project = existing
        else:
            repo = json.loads(subprocess.check_output(["gh", "api", f"repos/{args.repo}"], text=True))
            secret = dotenv_values(ROOT / ".env").get("API_TOKEN")
            if not secret:
                raise RuntimeError("Local API_TOKEN is missing")
            environment = {
                "BOT_API_TOKEN": {"type": "secret_text", "value": secret},
                "BOT_API_URL": {"type": "secret_text", "value": args.bot_api_url},
                "NODE_VERSION": {"type": "plain_text", "value": "24.21.0"},
            }
            project = cf(base, "POST", {
                "name": args.project, "production_branch": "main",
                "build_config": {"build_command": "npm run build", "destination_dir": "dist", "root_dir": "/"},
                "source": {"type": "github", "config": {
                    "owner": repo["owner"]["login"], "owner_id": str(repo["owner"]["id"]),
                    "repo_name": repo["name"], "repo_id": str(repo["id"]), "production_branch": "main",
                    "production_deployments_enabled": True, "deployments_enabled": True,
                    "preview_deployment_setting": "all", "preview_branch_includes": ["*"],
                    "preview_branch_excludes": [], "pr_comments_enabled": False,
                }},
                "deployment_configs": {mode: {"env_vars": environment, "compatibility_date": "2026-10-18"} for mode in ["production", "preview"]},
            })
    elif args.action == "inspect":
        projects = cf(base)
        print(json.dumps([{"name": p["name"], "source": p.get("source"), "build_config": p.get("build_config")} for p in projects if p["name"] == args.project], indent=2))
        return
    elif args.action == "status":
        deployments = cf(base + f"/{args.project}/deployments")
        print(json.dumps([{"id": d["id"], "url": d["url"], "stage": d["latest_stage"], "commit": d.get("deployment_trigger", {}).get("metadata", {}).get("commit_hash"), "stages": d.get("stages")} for d in deployments[:3]], indent=2))
        return
    elif args.action == "retry":
        project = cf(base + f"/{args.project}/deployments", "POST", {"branch": "main"})
        print(json.dumps({"id": project["id"], "url": project["url"], "stage": project["latest_stage"]}, indent=2))
        return
    else:
        if not args.deployment:
            raise RuntimeError("--deployment is required")
        result = cf(base + f"/{args.project}/deployments/{args.deployment}/history/logs")
        # Build logs may contain service diagnostics, but never print env_vars.
        print(json.dumps(result, indent=2))
        return
    print(json.dumps({"name": project["name"], "subdomain": project.get("subdomain"),
                      "source": project.get("source"), "build_config": project.get("build_config"),
                      "environmentKeys": {mode: list(project.get("deployment_configs", {}).get(mode, {}).get("env_vars", {})) for mode in ["production", "preview"]}}, indent=2))


if __name__ == "__main__":
    main()
