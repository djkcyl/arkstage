#!/usr/bin/env python3
"""One-time, explicitly authorized release-key setup; never run from CI."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess

ROOT = Path(__file__).resolve().parents[1]
PRIVATE = ROOT / ".release-signing"
POLICY = ROOT / "config/android-signing.json"
REPO = "djkcyl/arkstage"


def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--generate", action="store_true", help="initialize a new signing identity only if none exists")
    parser.add_argument("--upload-github", action="store_true", help="store the established identity in this repository's encrypted Actions Secrets")
    args = parser.parse_args()
    os.umask(0o077)
    if run(["git", "check-ignore", ".release-signing/recovery.json"], cwd=ROOT, capture_output=True).returncode != 0:
        raise SystemExit("Private backup directory must be ignored by Git")
    PRIVATE.mkdir(mode=0o700, exist_ok=True)
    PRIVATE.chmod(0o700)
    recovery = PRIVATE / "recovery.json"
    password_file = PRIVATE / "password.txt"
    key = PRIVATE / "arkstage-release.p12"
    if not recovery.exists():
        if POLICY.exists() or key.exists() or password_file.exists():
            raise SystemExit("An identity or partial backup already exists; restore it, never generate a replacement")
        if not args.generate:
            raise SystemExit("Initial key generation requires --generate and explicit owner authorization")
        password = secrets.token_urlsafe(48)
        password_file.write_text(password)
        run(["keytool", "-genkeypair", "-noprompt", "-storetype", "PKCS12", "-keystore", str(key),
             "-storepass:file", str(password_file), "-keypass:file", str(password_file),
             "-alias", "arkstage-release", "-keyalg", "RSA", "-keysize", "4096", "-validity", "10000",
             "-dname", "CN=Arkstage Release,O=Arkstage,C=CN"], capture_output=True)
        recovery.write_text(json.dumps({"keystore": key.name, "keyAlias": "arkstage-release",
                                        "storePassword": password, "keyPassword": password}, indent=2) + "\n")
    saved = json.loads(recovery.read_text())
    if not key.is_file() or not password_file.is_file():
        raise SystemExit("Signing backup is incomplete; restore the original key")
    if saved["storePassword"] != password_file.read_text() or saved["keyPassword"] != saved["storePassword"]:
        raise SystemExit("Recovery credentials disagree; restore the intact backup before configuring CI")
    certificate = run(["keytool", "-exportcert", "-keystore", str(key), "-storetype", "PKCS12",
                       "-storepass:file", str(password_file), "-alias", saved["keyAlias"]], capture_output=True).stdout
    fingerprint = hashlib.sha256(certificate).hexdigest()
    if POLICY.exists():
        policy = json.loads(POLICY.read_text())
        if policy["certificateSha256"] != fingerprint or policy["keyAlias"] != saved["keyAlias"]:
            raise SystemExit("Local backup does not match the established signing policy")
    else:
        version = json.loads((ROOT / "package.json").read_text())["version"]
        policy = {"schemaVersion": 1, "packageName": "cn.aunly.arkstage", "keyAlias": saved["keyAlias"],
                  "certificateSha256": fingerprint, "firstSignedVersion": version,
                  "previousCertificateSha256": "c7abaa362386570e28c7df3791fa1e41052e26f515a6389c94536f0ad7dcede8",
                  "migrationReason": "The previous CI debug private key was not retained; a permanent release identity starts here."}
        POLICY.parent.mkdir(parents=True, exist_ok=True)
        POLICY.write_text(json.dumps(policy, indent=2) + "\n")
        POLICY.chmod(0o644)
    for path in PRIVATE.iterdir():
        if path.is_file():
            path.chmod(0o600)
    if args.upload_github:
        values = {"ANDROID_KEYSTORE_BASE64": base64.b64encode(key.read_bytes()),
                  "ANDROID_KEYSTORE_PASSWORD": saved["storePassword"].encode(),
                  "ANDROID_KEY_ALIAS": saved["keyAlias"].encode(),
                  "ANDROID_KEY_PASSWORD": saved["keyPassword"].encode()}
        for name, value in values.items():
            run(["gh", "secret", "set", name, "--repo", REPO], input=value, capture_output=True)
        print("Fixed release identity configured in GitHub Actions Secrets")
    print("Certificate SHA-256:", fingerprint)
    print("Private recovery directory:", PRIVATE)


if __name__ == "__main__":
    main()
