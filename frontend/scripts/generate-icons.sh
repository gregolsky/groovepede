#!/usr/bin/env bash
set -euo pipefail

# Extract the complete centipede from the original logo. The previous wordless
# derivative faded away the lower edges of the vinyl records and must not be
# used as a source.
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
source_logo="$repo_root/groovepede.xcf"
icons_dir="$repo_root/frontend/public/icons"
play_icon="$repo_root/android/store-listing/icon-512x512.png"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

command -v magick >/dev/null || { echo 'ImageMagick (magick) is required' >&2; exit 1; }

# This crop contains the complete centipede while excluding the original
# rounded badge and GROOVEPEDE wordmark. Build an alpha mask from the mint
# artwork so its original dark outlines and record grooves remain intact.
magick "$source_logo" -crop 970x870+130+110 +repage "$tmp_dir/crop.png"
magick "$tmp_dir/crop.png" \
  \( +clone -alpha off \
     -fx 'g>0.16 && g>r*1.35 && g>b*1.08 ? 1 : 0' \
     -morphology Close Disk:10 -morphology Dilate Disk:7 -blur 0x2 \) \
  -alpha off -compose CopyOpacity -composite "$tmp_dir/mark.png"

# Standard and Play icons use the full mark with at least 40 px of clearance.
magick -size 512x512 xc:'#0d1113' \
  \( "$tmp_dir/mark.png" -resize 430x386 \) \
  -gravity center -compose Over -composite -colorspace sRGB -alpha on \
  -define png:color-type=6 "$icons_dir/icon-512x512.png"

# Maskable icons reserve the outer 10% on every side. Scale the complete mark
# down further so notes, legs, and every vinyl edge remain inside that circle.
magick -size 512x512 xc:'#0d1113' \
  \( "$tmp_dir/mark.png" -filter Lanczos -resize 340x340 \
     -unsharp '0x0.7+0.9+0.02' \) \
  -gravity center -compose Over -composite -colorspace sRGB -alpha on \
  -define png:color-type=6 "$icons_dir/icon-512x512-maskable.png"
cp "$icons_dir/icon-512x512.png" "$play_icon"

for size in 192 180 32 16; do
  magick "$icons_dir/icon-512x512.png" -resize "${size}x${size}" \
    -alpha on -define png:color-type=6 "$icons_dir/icon-${size}x${size}.png"
done
