#!/usr/bin/env bash
# Stores the Microsoft Entra sign-in settings in SSM Parameter Store.
# Values are read interactively and passed to AWS via a private temp file, so they never
# appear in shell history, process arguments, or this repository.
# The files.dliu.com app registration can be reused: press Enter to copy its values.
set -euo pipefail

REGION="${AWS_REGION:-eu-west-1}"
PREFIX="${PARAMETER_PREFIX:-/share}"
OTHER="${REUSE_PREFIX:-/files}"

get() { # full-name
  aws ssm get-parameter --region "$REGION" --name "$1" --with-decryption --query Parameter.Value --output text 2>/dev/null || true
}

put() { # name type value
  # The value goes through a private temp file (not argv) so it never shows up in `ps`.
  local input
  input="$(umask 077; mktemp)"
  NAME="$PREFIX/$1" TYPE="$2" VALUE="$3" node -e '
    process.stdout.write(JSON.stringify({ Name: process.env.NAME, Type: process.env.TYPE, Value: process.env.VALUE, Overwrite: true }));
  ' > "$input"
  if ! aws ssm put-parameter --region "$REGION" --cli-input-json "file://$input" >/dev/null; then
    rm -f "$input"
    echo "Failed to save $PREFIX/$1" >&2
    exit 1
  fi
  rm -f "$input"
  echo "  saved $PREFIX/$1 ($2)"
}

prompt() { # var label default
  local value
  read -r -p "$2${3:+ [$3]}: " value
  printf -v "$1" '%s' "${value:-$3}"
}

default() { # name: the current value, else the one under $OTHER
  local value
  value="$(get "$PREFIX/$1")"
  [[ -n "$value" ]] || value="$(get "$OTHER/$1")"
  printf '%s' "$value"
}

echo "Microsoft Entra settings for share.dliu.com (region $REGION)."
echo "In the app registration, add the Web redirect URI: https://share.dliu.com/auth/callback"
echo "Press Enter to keep the value shown in brackets (taken from $PREFIX, or else from $OTHER)."
prompt TENANT_ID "Directory (tenant) ID" "$(default entra-tenant-id)"
prompt CLIENT_ID "Application (client) ID" "$(default entra-client-id)"
read -r -s -p "Client secret VALUE (hidden; Enter to keep the current one or reuse $OTHER's when the client ID matches): " CLIENT_SECRET; echo

[[ -n "$TENANT_ID" && -n "$CLIENT_ID" ]] || { echo "Tenant ID and client ID are required." >&2; exit 1; }

if [[ -z "$CLIENT_SECRET" && -z "$(get "$PREFIX/entra-client-secret")" ]]; then
  if [[ "$CLIENT_ID" == "$(get "$OTHER/entra-client-id")" ]]; then
    CLIENT_SECRET="$(get "$OTHER/entra-client-secret")"
  fi
  [[ -n "$CLIENT_SECRET" ]] || { echo "No client secret stored yet; run again and enter it." >&2; exit 1; }
fi

put entra-tenant-id String "$TENANT_ID"
put entra-client-id String "$CLIENT_ID"
[[ -z "$CLIENT_SECRET" ]] || put entra-client-secret SecureString "$CLIENT_SECRET"
echo "Done. The app picks up changes within 5 minutes."
