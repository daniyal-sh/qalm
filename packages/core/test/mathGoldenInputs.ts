/**
 * Inputs of `fixtures/mathGolden.json`: layouts and TeX boxes made by the synchronous MathJax code from before MathJax
 * loaded on demand. Once loaded, the lazy path must lay them out exactly the same (`mathLazy.test.ts`).
 */
export const MATH_GOLDEN_INPUTS: { layouts: [text: string, width: number, fontSize: number][]; tex: [tex: string, display: boolean][] } = {
  layouts: [
    ['Energy $E = mc^2$ and $\\frac{a}{b}$ inline, then more words to wrap the line.', 240, 16],
    ['# Maths\n\n$$\\int_0^1 x^2\\,dx = \\frac{1}{3}$$\n\n- item $\\sqrt{2}$\n- $\\alpha+\\beta$', 300, 18],
    ['$$a+b+c+d+e+f+g+h+i+j+k+l+m+n+o+p$$', 80, 16],
    ['> quote $x_i^2$ **bold** ~~$y$~~ [link $z$](https://a.b)', 200, 14],
    ['$\\frac{1}{$ broken and $$\\sqrt{$$', 300, 16],
    ['$$\n\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}\n$$', 300, 16],
    ['1. $\\sum_{i=1}^n i = \\frac{n(n+1)}{2}$\n2. $\\mathbf{v} \\cdot \\boldsymbol{w}$', 160, 20],
    ['**b** *i* `c` no maths $5 and $6', 240, 16],
  ],
  tex: [
    ['\\frac{a}{b}', false],
    ['\\int_0^\\infty e^{-x}\\,dx', true],
    ['\\frac{1}{', false],
  ],
};
