# BIOBUZZ field images

Field images by **Team Juice 16236**, from the r/FTC post "BIOBUZZ custom field images (MeepMeep
compatible)" (https://www.reddit.com/r/FTC/comments/1weleaj/biobuzz_custom_field_images_meepmeep_compatible/).
The author asks that any public resource or path generator using them credits Team Juice 16236.
The owner supplied the files on 2026-09-22.

| file | background | size | pixels |
|---|---|---|---|
| `biobuzz-dark.webp` | dark grey | 23.7 KB | 1080 × 1080 |
| `biobuzz-black.webp` | black | 24.1 KB | 1080 × 1080 |
| `biobuzz-light.webp` | white (printable) | 28.2 KB | 1080 × 1080 |

## Alignment to the Zenith frame

- **Full bleed.** The image edges are the field perimeter. The grid lines fall every 180 px,
  which is one 24 in tile, so 1080 px spans the whole 144 in field.
- **Rotate 90 degrees clockwise** for display with the audience at the bottom (Zenith frame:
  centre origin, +X to audience-right, +Y away from the audience). The image draws the RED hive
  below the BLUE hive; Zenith has RED at −X, on the left.
- Checked against `packages/season-biobuzz/field/biobuzz.field.json` after rotation. The red
  bracket lands at x −72..−60 in, y 24..48 in, which is the RED loading zone (x −72..−61,
  y 24..48). The four flowers land at (−72, −24), (−24, 72), (72, 24) and (24, −72); flower0 is
  transcribed at (−69.46, −24). The RED hive sits left of centre, as hiveRed's pivot (−12.75, 0).
