"""Configure the Git-integrated Pages project using Wrangler's OAuth login.

Run with uv run python scripts/cloudflare-project.py --account ACCOUNT_ID create.
Secrets are loaded from private files and never printed or passed in argv.
"""
import argparse
import json
import subprocess
import tomllib
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parent.parent
PROJECT = "zorr-mob-notifier"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--account", required=True)
    parser.add_argument("action", choices=["inspect", "create", "status", "retry", "logs"])
    parser.add_argument("--deployment")
    args = parser.parse_args()
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
        existing = next((p for p in cf(base) if p["name"] == PROJECT), None)
        if existing:
            if existing.get("source", {}).get("config", {}).get("repo_name") != PROJECT:
                raise RuntimeError("An unrelated or Direct Upload project exists; refusing to replace it")
            project = existing
        else:
            repo = json.loads(subprocess.check_output(["gh", "api", "repos/suicanifuramu/zorr-mob-notifier"], text=True))
            secret = dotenv_values(ROOT / ".env").get("API_TOKEN")
            if not secret:
                raise RuntimeError("Local API_TOKEN is missing")
            environment = {
                "BOT_API_TOKEN": {"type": "secret_text", "value": secret},
                "BOT_API_URL": {"type": "plain_text", "value": "https://zorr-mob-notifier.info.gf"},
                "NODE_VERSION": {"type": "plain_text", "value": "24.21.0"},
            }
            project = cf(base, "POST", {
                "name": PROJECT, "production_branch": "main",
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
        print(json.dumps([{"name": p["name"], "source": p.get("source"), "build_config": p.get("build_config")} for p in projects if p["name"] in [PROJECT, "zorr-assembler"]], indent=2))
        return
    elif args.action == "status":
        deployments = cf(base + f"/{PROJECT}/deployments")
        print(json.dumps([{"id": d["id"], "url": d["url"], "stage": d["latest_stage"], "commit": d.get("deployment_trigger", {}).get("metadata", {}).get("commit_hash"), "stages": d.get("stages")} for d in deployments[:3]], indent=2))
        return
    elif args.action == "retry":
        project = cf(base + f"/{PROJECT}/deployments", "POST", {"branch": "main"})
        print(json.dumps({"id": project["id"], "url": project["url"], "stage": project["latest_stage"]}, indent=2))
        return
    else:
        if not args.deployment:
            raise RuntimeError("--deployment is required")
        result = cf(base + f"/{PROJECT}/deployments/{args.deployment}/history/logs")
        # Build logs may contain service diagnostics, but never print env_vars.
        print(json.dumps(result, indent=2))
        return
    print(json.dumps({"name": project["name"], "subdomain": project.get("subdomain"),
                      "source": project.get("source"), "build_config": project.get("build_config"),
                      "environmentKeys": {mode: list(project.get("deployment_configs", {}).get(mode, {}).get("env_vars", {})) for mode in ["production", "preview"]}}, indent=2))


if __name__ == "__main__":
    main()
