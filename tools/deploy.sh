#!/usr/bin/env bash
# Deploy the National Ships Ledger to Supabase + GitHub Pages.
#
# Needs (as environment variables, never committed):
#   SUPABASE_DB_URL        Session pooler connection string, with the database password
#   SUPABASE_ACCESS_TOKEN  Personal access token from https://supabase.com/dashboard/account/tokens
# Optional:
#   ADMIN_EMAIL            First administrator's email (created only if no administrator exists yet)
#   APP_URL                Where the app is served (default: this repo's GitHub Pages address)
#   SKIP_PAGES=1           Don't publish the app to GitHub Pages
#
# Safe to re-run: migrations already applied are skipped, the function is redeployed,
# and the first administrator is only created once.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${SUPABASE_DB_URL:?Set SUPABASE_DB_URL}" "${SUPABASE_ACCESS_TOKEN:?Set SUPABASE_ACCESS_TOKEN}"
CLI="npx -y supabase@2.118.0"
REF=$(grep -o 'https://[a-z0-9]*\.supabase\.co' public/config.js | head -1 | sed -E 's#https://([a-z0-9]+)\.supabase\.co#\1#')
SUPABASE_URL="https://$REF.supabase.co"
REMOTE=$(git remote get-url origin | sed -E 's#(git@github.com:|https://github.com/)##; s#\.git$##')
OWNER=${REMOTE%%/*}; REPO=${REMOTE##*/}
APP_URL=${APP_URL:-"https://$OWNER.github.io/$REPO/"}
APP_ORIGIN=$(echo "$APP_URL" | sed -E 's#^(https?://[^/]+).*#\1#')
mgmt() { curl -fsS -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H 'Content-Type: application/json' "$@"; }
echo "Project $REF, app $APP_URL"

echo "1/5 Database migrations"
$CLI db push --db-url "$SUPABASE_DB_URL" --include-all --yes

echo "2/5 Edge function admin-users"
$CLI functions deploy admin-users --project-ref "$REF" --no-verify-jwt --use-api
$CLI secrets set --project-ref "$REF" "ALLOWED_ORIGINS=$APP_ORIGIN,http://localhost:8080"

echo "3/5 Auth settings: no public sign-ups; site URL"
mgmt -X PATCH "https://api.supabase.com/v1/projects/$REF/config/auth" \
  -d "{\"disable_signup\": true, \"site_url\": \"$APP_URL\", \"uri_allow_list\": \"$APP_URL**\", \"password_min_length\": 10}" > /dev/null

echo "4/5 First administrator"
ADMINS=$(psql "$SUPABASE_DB_URL" -Atc "select count(*) from public.profiles where role = 'admin' and active")
if [ "$ADMINS" = "0" ]; then
  : "${ADMIN_EMAIL:?No administrator exists yet: set ADMIN_EMAIL to create one}"
  SERVICE_KEY=$(mgmt "https://api.supabase.com/v1/projects/$REF/api-keys?reveal=true" | python3 -c "import json,sys; print(next(k['api_key'] for k in json.load(sys.stdin) if k['name'] == 'service_role'))")
  TEMP_PW="$(python3 -c "import secrets,string; a=string.ascii_letters+string.digits; print(''.join(secrets.choice(a) for _ in range(14))+'7a')")"
  curl -fsS -X POST "$SUPABASE_URL/auth/v1/admin/users" -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY" -H 'Content-Type: application/json' \
    -d "{\"email\": \"$ADMIN_EMAIL\", \"password\": \"$TEMP_PW\", \"email_confirm\": true}" > /dev/null
  echo "select public.bootstrap_admin(:'email');" | psql "$SUPABASE_DB_URL" -q -v ON_ERROR_STOP=1 -v email="$ADMIN_EMAIL"
  echo "   Administrator $ADMIN_EMAIL created. Temporary password (shown once, must be changed at first sign-in): $TEMP_PW"
else
  echo "   An administrator already exists; skipped."
fi

echo "5/5 App on GitHub Pages"
if [ "${SKIP_PAGES:-}" != "1" ]; then
  git subtree split --prefix public -b pages-build >/dev/null
  git push -f origin pages-build:gh-pages
  git branch -D pages-build >/dev/null
  gh api "repos/$OWNER/$REPO/pages" >/dev/null 2>&1 || gh api -X POST "repos/$OWNER/$REPO/pages" -f "source[branch]=gh-pages" -f "source[path]=/" >/dev/null
  echo "   Published. GitHub Pages can take a minute or two: $APP_URL"
fi
echo "Done."
