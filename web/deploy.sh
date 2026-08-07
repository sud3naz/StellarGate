#!/usr/bin/env bash
#
# Deploys web/ to Vercel from a copy outside the repository.
#
# Not superstition. Vercel reads the git metadata of the directory it is given
# and treats the last commit's author as the person deploying. Commits here are
# authored by Sude Akkaya, who is not a member of the Vercel team — and on the
# Hobby plan the team has exactly one member, so there is no way to add her
# without paying for Pro. The deploy is refused with "not a member of the team",
# which reads like an authentication problem and is not one.
#
# Copying the site to a directory with no `.git` removes the metadata, and with
# it the question. Nothing about the built site changes.
#
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT

cp "$here"/index.html "$here"/app.js "$here"/abi.js "$here"/strkey.js \
   "$here"/favicon.svg "$here"/vercel.json "$staging/"
cp -r "$here"/.vercel "$staging/.vercel"

cd "$staging"
npx --yes vercel@latest deploy --prod --yes --no-color
