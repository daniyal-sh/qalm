# Handwriting fonts

Single-line ("engraving") SVG fonts from the EMS collection by Sheldon B. Michaels, converted to SVG fonts by
Windell H. Oskay (<https://gitlab.com/oskay/svg-fonts>). Both are released under the **SIL Open Font License 1.1**
(`OFL.txt`). They are used only to generate the showcase's demo ink (`../hand.mjs`); they are not shipped in the app.

| File | Font | A derivative of |
|---|---|---|
| `EMSCasualHand.svg` | EMS Casual Hand | Covered By Your Grace, by Kimberly Geswein |
| `EMSAllure.svg` | EMS Allure | Allura, by Rob Leuschke (TypeSETit) |

The files are unmodified. `hand.mjs` redraws two Casual Hand glyphs at load time (`t` and `f`, which the font draws as
one zig-zag stroke) and adds a few maths glyphs the fonts lack (∫ π θ Δ → √ …).
