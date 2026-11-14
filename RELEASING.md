# Releasing

The Signal K App Store (server 2.37) builds a plugin's **Changelog** tab from the
repository's GitHub Releases (`https://github.com/Haimana/signalk-alecoair/releases.atom`).
A tag without a release shows up there with the tag's commit message instead,
which is what happened to 0.0.4 at first. Only without any GitHub data does it
fall back to `CHANGELOG.md`. So every published version needs a GitHub release
whose body is that version's CHANGELOG section, created right when its tag
reaches GitHub.

Not in the npm package: this file, `scripts/` and `release-notes/` (see
`files` in `package.json`).

## Before

1. `CHANGELOG.md`: a `## X.Y.Z (YYYY-MM-DD)` section, user-facing, in the style
   of the earlier ones. Write it for GitHub's renderer and the App Store's
   HTML-to-markdown step: plain markdown, no raw HTML, angle brackets only
   inside code spans.
2. Version `X.Y.Z` in `package.json`, `package-lock.json` and `openapi.json`.
3. Release notes file: `npm run release-notes --silent -- X.Y.Z > release-notes/vX.Y.Z.md`
   (the section body without its `##` heading, which becomes the release
   title). Commit it.
4. The commit that gets tagged should have a message that reads well as a
   release summary (the App Store's fallback), e.g.
   `vX.Y.Z: <what changed, in a few words>`.
5. That commit is on `main` and pushed: `git checkout main && git merge --ff-only <branch> && git push origin main`.

## Publish and release

Run from a clean `main` checkout at the release commit:

```sh
V=X.Y.Z                      # e.g. 0.0.5
DATE=YYYY-MM-DD              # the date in the CHANGELOG heading
npm login                    # once per machine; npm whoami to check
npm test
npm pack --dry-run           # check the file list and version
npm publish
git tag "v$V"                # on the published commit (HEAD)
git push origin "v$V"
gh release create "v$V" --verify-tag --title "v$V ($DATE)" --notes-file "release-notes/v$V.md" --latest
```

Run the last two commands back to back, so the App Store never sees a bare tag.
Alternative without a separate tag push (gh creates the tag on GitHub at the
given commit, which must already be pushed):

```sh
gh release create "v$V" --target "$(git rev-parse HEAD)" --title "v$V ($DATE)" --notes-file "release-notes/v$V.md" --latest
git fetch --tags
```

Check: `https://github.com/Haimana/signalk-alecoair/releases/tag/vX.Y.Z` shows
the notes, and `releases.atom` lists the version with them.

## After

The App Store caches the plugin detail. On each server (Haimana), move the
cache file aside so the Changelog tab is rebuilt on the next visit:

```sh
mkdir -p /tmp/appstore-cache-aside
mv ~/.signalk/appstore-cache/plugins/signalk-alecoair/detail.json /tmp/appstore-cache-aside/detail.json.$(date +%s)
```

If a release body needs fixing later: `gh release edit vX.Y.Z --notes-file release-notes/vX.Y.Z.md`, then move the cache aside again.
