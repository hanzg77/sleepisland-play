#!/usr/bin/env python3

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "cover-background.png"
OUTPUT = ROOT / "cover.png"
WIDTH = 1080
HEIGHT = 1920


def font(path: str, size: int, index: int = 0) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(path, size=size, index=index)


def draw_text_with_shadow(
    draw: ImageDraw.ImageDraw,
    position: tuple[int, int],
    text: str,
    text_font: ImageFont.FreeTypeFont,
    fill: tuple[int, int, int, int],
    shadow_offset: int = 4,
) -> None:
    x, y = position
    draw.text((x + shadow_offset, y + shadow_offset), text, font=text_font, fill=(0, 18, 34, 150))
    draw.text((x, y), text, font=text_font, fill=fill)


def main() -> None:
    if not SOURCE.exists():
        raise SystemExit(f"Missing generated background: {SOURCE}")

    image = Image.open(SOURCE).convert("RGB").resize((WIDTH, HEIGHT), Image.Resampling.LANCZOS)
    overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    for y in range(0, 820):
        alpha = round(154 * (1 - y / 820) ** 1.55)
        draw.line((0, y, WIDTH, y), fill=(0, 24, 47, alpha))

    chinese_font = "/System/Library/Fonts/STHeiti Medium.ttc"
    mono_font = "/System/Library/Fonts/SFNSMono.ttf"
    label = font(chinese_font, 31)
    title_large = font(chinese_font, 118)
    title_small = font(chinese_font, 70)
    subtitle = font(chinese_font, 39)
    formula = font(mono_font, 31)

    label_box = (72, 108, 455, 164)
    draw.rounded_rectangle(label_box, radius=28, fill=(2, 39, 65, 124), outline=(178, 245, 255, 72), width=2)
    draw.text((95, 118), "生成艺术 · 数学可视化", font=label, fill=(203, 248, 255, 235))

    draw_text_with_shadow(draw, (68, 220), "数学公式", title_large, (235, 253, 255, 255))
    draw_text_with_shadow(draw, (72, 358), "生成的深海水母？", title_small, (187, 244, 255, 255), 3)

    panel = (70, 488, 938, 646)
    draw.rounded_rectangle(panel, radius=24, fill=(0, 25, 48, 132), outline=(191, 247, 255, 58), width=2)
    draw.text((102, 518), "x = 99 sin(c) + kp + 200", font=formula, fill=(218, 252, 255, 244))
    draw.text((102, 570), "y = 99 sin(4c) + ep + 200", font=formula, fill=(218, 252, 255, 244))

    draw_text_with_shadow(draw, (72, 686), "每一个光点，都是算出来的", subtitle, (216, 249, 252, 238), 2)

    image = Image.alpha_composite(image.convert("RGBA"), overlay).convert("RGB")
    image.save(OUTPUT, format="PNG", optimize=True)
    print(OUTPUT)


if __name__ == "__main__":
    main()
