#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/fixtures/linux" "$tmp/fixtures/windows" "$tmp/fixtures/release"
printf 'appimage\n' > "$tmp/fixtures/linux/LocalWORK test.AppImage"
printf 'deb\n' > "$tmp/fixtures/linux/LocalWORK.deb"
printf 'rpm\n' > "$tmp/fixtures/linux/LocalWORK.rpm"
printf 'installer\n' > "$tmp/fixtures/windows/LocalWORK-setup.exe"
printf 'pkgbuild\n' > "$tmp/fixtures/release/PKGBUILD"

# Stub only the GitHub boundary; the actual workflow shell and sha256sum run unchanged.
cat > "$tmp/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "$1 $2" in
  'run view')
    if [ "$3" = 1 ]; then printf 'Linux build success\n'; else printf 'Windows build success\n'; fi ;;
  'run download')
    if [ "$3" = 1 ]; then source_dir=linux; else source_dir=windows; fi
    mkdir -p "$7"
    cp "$FIXTURES/$source_dir/"* "$7/" ;;
  'release download')
    mkdir -p "$7"
    cp "$FIXTURES/release/PKGBUILD" "$7/PKGBUILD" ;;
  'release upload')
    shift 3
    mkdir -p "$PUBLISHED"
    for file in "$@"; do
      [ "$file" = --clobber ] || cp "$file" "$PUBLISHED/"
    done ;;
  *) printf 'Unexpected gh invocation: %s\n' "$*" >&2; exit 1 ;;
esac
EOF
chmod +x "$tmp/bin/gh"
workflow="$root/.github/workflows/linux-publish.yml"
awk -v dir="$tmp" '
  /^        run: \|$/ { inside=1; count++; next }
  inside && /^          / { sub(/^          /, ""); print > (dir "/step" count ".sh"); next }
  inside { inside=0 }
  END { if (count != 2) { print "Expected separate preparation and upload steps" > "/dev/stderr"; exit 1 } }
' "$workflow"
subject_path=$(awk '/^          subject-path: / { print $2 }' "$workflow")
[ -n "$subject_path" ] || { printf 'Missing attestation subject path\n' >&2; exit 1; }
export PATH="$tmp/bin:$PATH" FIXTURES="$tmp/fixtures" RUN_ID=1 TAG=v1.2.3

for windows in no yes; do
  mkdir -p "$tmp/$windows"
  export PUBLISHED="$tmp/$windows/published"
  if [ "$windows" = yes ]; then export WIN_RUN_ID=2; else export WIN_RUN_ID=; fi
  (cd "$tmp/$windows" && bash -eo pipefail "$tmp/step1.sh")
  # The configured subject glob must select exactly the bytes subsequently uploaded.
  (cd "$tmp/$windows" && for file in $subject_path; do cp "$file" "$tmp/$windows/attested-${file##*/}"; done)
  (cd "$tmp/$windows" && bash -eo pipefail "$tmp/step2.sh")
  for file in "$PUBLISHED/"*; do
    cmp "$file" "$tmp/$windows/attested-${file##*/}"
  done
  [ "$(find "$tmp/$windows" -maxdepth 1 -type f -name 'attested-*' | wc -l)" -eq "$(find "$PUBLISHED" -maxdepth 1 -type f | wc -l)" ]
  [ -f "$PUBLISHED/SHA256SUMS" ] || { printf 'Missing SHA256SUMS (%s)\n' "$windows" >&2; exit 1; }
  (cd "$PUBLISHED" && sha256sum --check SHA256SUMS)
  expected=4
  [ "$windows" = no ] || expected=5
  [ "$(wc -l < "$PUBLISHED/SHA256SUMS")" -eq "$expected" ]
  [ "$(find "$PUBLISHED" -maxdepth 1 -type f | wc -l)" -eq "$((expected + 1))" ]
  ! grep -q 'SHA256SUMS$' "$PUBLISHED/SHA256SUMS"
  cmp "$PUBLISHED/SHA256SUMS" <(LC_ALL=C sort -k2 "$PUBLISHED/SHA256SUMS")
  printf 'tampered\n' >> "$PUBLISHED/LocalWORK.deb"
  if (cd "$PUBLISHED" && sha256sum --check --status SHA256SUMS); then
    printf 'Tampering was not detected (%s)\n' "$windows" >&2
    exit 1
  fi
done

# Publishing without the locally prepared PKGBUILD must fail, not omit it silently.
rm "$FIXTURES/release/PKGBUILD"
mkdir -p "$tmp/missing"
export PUBLISHED="$tmp/missing/published" WIN_RUN_ID=
if (cd "$tmp/missing" && bash -eo pipefail "$tmp/step1.sh"); then
  printf 'Publish succeeded without PKGBUILD\n' >&2
  exit 1
fi
[ ! -d "$PUBLISHED" ]

printf 'Release publishing checksum tests passed\n'
