---
name: mastergo-use
description: >-
  MANDATORY prerequisite before calling `use_mastergo`, `mastergo_status`,
  `upload_local_images`, or `screenshot_node`. Provides exact verified MasterGo
  Plugin API (`mg.*`) syntax from `@mastergo/plugin-typings`, critical
  differences from Figma, reusable batch creation helpers, and visual
  verification workflows so canvas scripts succeed on the first run.
---

# MasterGo High-Throughput Canvas Skill (`use-mastergo-mcp`)

Use this skill whenever reading, creating, editing, or visually verifying MasterGo designs through the `use-mastergo-mcp` server.

---

## 1. Standard 4-Step Workflow

1. **Check connection first**: Call `mastergo_status` to confirm the MasterGo desktop plugin is connected, inspect existing pages/selection, and verify `capabilities.dynamicEval === true`.
2. **Upload local images in one batch (if needed)**: Call `upload_local_images({ paths: [...] })` BEFORE creating image nodes. It reads files from disk, downscales oversized images automatically, calls `mg.createImage()`, and returns `{ images: { [path]: imageRef } }`.
3. **Batch canvas mutations in `use_mastergo`**: Build an entire section, card grid, or full artboard inside **one** `use_mastergo(code, description)` call instead of issuing tiny per-node calls. Always `return` a structured summary containing created node IDs, bounding boxes, and page info.
4. **Visually self-verify**: Call `screenshot_node({ nodeId, scale: 2 })` on the root frame you created or modified. Inspect the rendered PNG for text clipping, unintended white backgrounds, overlapping layers, or contrast issues, and fix any flaws immediately in a follow-up `use_mastergo` call.

---

## 2. Critical Differences: MasterGo (`mg.*`) vs Figma (`figma.*`)

Every signature below is verified directly against `@mastergo/plugin-typings` v2.19.5. **Do not copy Figma idioms blindly.**

| Feature | Figma API (WRONG in MasterGo) | MasterGo API (EXACT) |
| :--- | :--- | :--- |
| **Root & Current Page** | `figma.root`, `figma.currentPage` | `mg.document`, `mg.document.currentPage` |
| **Visibility & Lock** | `node.visible`, `node.locked` | `node.isVisible`, `node.isLocked` |
| **Solid Paint Alpha** | `{ type: 'SOLID', color: { r, g, b }, opacity: 0.5 }` | `{ type: 'SOLID', color: { r, g, b, a: 0.5 }, isVisible: true }` (`color` is `RGBA`; `alpha` on `SolidPaint` is ignored!) |
| **Hex to Color Helper** | `figma.util.solidPaint('#...')` | `mg.hexToRGBA('#RRGGBB')` or `mg.hexToRGBA('#RRGGBBAA')` |
| **Image Creation & Fill** | `figma.createImage(u8)` (sync) → `{ type: 'IMAGE', imageHash: img.hash }` | `await mg.createImage(u8)` (**async**) → `{ type: 'IMAGE', imageRef: img.href, scaleMode: 'FILL' }` |
| **Text Styling** | `text.fontName = ...`, `text.fontSize = 16`, `text.lineHeight = ...` | **Range setters**: `text.setRangeFontName(0, len, font)`, `text.setRangeFontSize(0, len, 16)`, `text.setRangeLineHeight(0, len, { value: 24, unit: 'PIXELS' })`, `text.setRangeLetterSpacing(0, len, { value: 0, unit: 'PIXELS' })` |
| **Auto Layout Direction** | `frame.layoutMode = 'VERTICAL'` | `frame.flexMode = 'VERTICAL'` (`'NONE' \| 'HORIZONTAL' \| 'VERTICAL'`) |
| **Auto Layout Align** | `primaryAxisAlignItems = 'SPACE_BETWEEN'`, `counterAxisAlignItems = 'MIN'` | `mainAxisAlignItems = 'SPACING_BETWEEN'` (`'FLEX_START' \| 'FLEX_END' \| 'CENTER' \| 'SPACING_BETWEEN'`), `crossAxisAlignItems = 'FLEX_START'` (`'FLEX_START' \| 'FLEX_END' \| 'CENTER'`) |
| **Auto Layout Sizing** | `primaryAxisSizingMode`, `counterAxisSizingMode`, `layoutSizingHorizontal` | `mainAxisSizingMode: 'FIXED' \| 'AUTO'`, `crossAxisSizingMode: 'FIXED' \| 'AUTO'` |
| **Auto Layout Wrap** | `layoutWrap = 'WRAP'` | `flexWrap = 'WRAP'` (`'NO_WRAP' \| 'WRAP'`, horizontal containers only) |
| **Auto Layout Child** | `child.layoutGrow = 1`, `child.layoutAlign = 'STRETCH'` | `child.flexGrow = 1` (`0 \| 1`), `child.alignSelf = 'STRETCH'` (`'STRETCH' \| 'INHERIT'`), `child.layoutPositioning = 'AUTO' \| 'ABSOLUTE'` |
| **SVG Import** | `figma.createNodeFromSvg(svg)` (sync) | `await mg.createNodeFromSvgAsync(svg)` (**async**) |
| **Shadows & Blur** | `{ type: 'DROP_SHADOW', visible: true, ... }` | `{ type: 'DROP_SHADOW', isVisible: true, isEffectShow: true, showShadowBehindNode: false, blendMode: 'NORMAL', color: RGBA, offset: { x, y }, radius, spread }` |
| **Vector / Path Node** | `figma.createVector()` | `mg.createPen()` (`node.type === 'PEN'`) |
| **Export Image** | `node.exportAsync({ format: 'PNG', constraint: ... })` | `await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 2 } })` |

---

## 3. Verified Helper Snippets for `use_mastergo`

Paste only the helpers you need at the top of your `use_mastergo` script.

### 3.1 Color & Fill Helpers
```javascript
function rgba(hex, a = 1) {
  const c = mg.hexToRGBA(hex);
  return { r: c.r, g: c.g, b: c.b, a: a !== undefined ? a : c.a };
}

function solid(hex, a = 1) {
  return { type: "SOLID", color: rgba(hex, a), isVisible: true };
}

function imageFill(imageRef, scaleMode = "FILL") {
  return { type: "IMAGE", imageRef, scaleMode, isVisible: true, alpha: 1 };
}

function dropShadow(hex, alpha, y, radius, spread = 0, x = 0) {
  return {
    type: "DROP_SHADOW",
    color: rgba(hex, alpha),
    offset: { x, y },
    radius,
    spread,
    isVisible: true,
    isEffectShow: true,
    showShadowBehindNode: false,
    blendMode: "NORMAL",
  };
}
```

### 3.2 Safe Font Loading & Text Creation (CRITICAL!)
Always discover/load an available font first, set `characters`, and apply styling with `setRange*` methods.

```javascript
const loadedFonts = new Set();

async function ensureFont(family, style = "Regular") {
  const key = `${family}::${style}`;
  if (loadedFonts.has(key)) return { family, style };
  const ok = await mg.loadFontAsync({ family, style });
  if (ok) {
    loadedFonts.add(key);
    return { family, style };
  }
  // Fallback: inspect available fonts and pick a working one
  const available = await mg.listAvailableFontsAsync();
  const match =
    available.find((f) => f.fontName.family === family) ||
    available.find((f) => /PingFang|Source Han|Noto Sans|Inter|Roboto/i.test(f.fontName.family)) ||
    available[0];
  if (!match) throw new Error(`No loadable font found for ${family} ${style}`);
  await mg.loadFontAsync(match.fontName);
  loadedFonts.add(`${match.fontName.family}::${match.fontName.style}`);
  return match.fontName;
}

async function addText(parent, opts) {
  const font = await ensureFont(opts.family || "PingFang SC", opts.style || "Regular");
  const t = mg.createText();
  t.name = opts.name || opts.text.slice(0, 24);
  t.characters = opts.text;
  const len = t.characters.length;
  if (len > 0) {
    t.setRangeFontName(0, len, font);
    if (opts.size) t.setRangeFontSize(0, len, opts.size);
    if (opts.lineHeight) {
      t.setRangeLineHeight(0, len, { value: opts.lineHeight, unit: "PIXELS" });
    }
    if (opts.letterSpacing !== undefined) {
      t.setRangeLetterSpacing(0, len, { value: opts.letterSpacing, unit: "PIXELS" });
    }
    if (opts.color) {
      t.setRangeFills(0, len, [solid(opts.color, opts.alpha ?? 1)]);
    }
  }
  if (opts.align) t.textAlignHorizontal = opts.align; // 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED'
  if (opts.width) {
    t.resize(opts.width, opts.height || 20);
    t.textAutoResize = opts.autoResize || "HEIGHT";
  } else {
    t.textAutoResize = opts.autoResize || "WIDTH_AND_HEIGHT";
  }
  parent.appendChild(t);
  if (opts.flexGrow !== undefined) t.flexGrow = opts.flexGrow;
  if (opts.alignSelf) t.alignSelf = opts.alignSelf;
  return t;
}
```

### 3.3 Auto Layout Container Helper
```javascript
function makeFrame(parent, opts = {}) {
  const f = mg.createFrame();
  f.name = opts.name || "Frame";
  if (opts.width !== undefined && opts.height !== undefined) {
    f.resize(opts.width, opts.height);
  }
  if (opts.x !== undefined) f.x = opts.x;
  if (opts.y !== undefined) f.y = opts.y;

  if (opts.flexMode && opts.flexMode !== "NONE") {
    f.flexMode = opts.flexMode; // 'HORIZONTAL' | 'VERTICAL'
    if (opts.gap !== undefined) f.itemSpacing = opts.gap;
    if (opts.mainAlign) f.mainAxisAlignItems = opts.mainAlign;
    if (opts.crossAlign) f.crossAxisAlignItems = opts.crossAlign;
    if (opts.mainSizing) f.mainAxisSizingMode = opts.mainSizing;
    if (opts.crossSizing) f.crossAxisSizingMode = opts.crossSizing;
    if (opts.padding !== undefined) {
      const [pt, pr, pb, pl] = Array.isArray(opts.padding)
        ? opts.padding.length === 2
          ? [opts.padding[0], opts.padding[1], opts.padding[0], opts.padding[1]]
          : opts.padding
        : [opts.padding, opts.padding, opts.padding, opts.padding];
      f.paddingTop = pt;
      f.paddingRight = pr;
      f.paddingBottom = pb;
      f.paddingLeft = pl;
    }
  }

  f.fills = opts.fills !== undefined ? opts.fills : opts.bg ? [solid(opts.bg, opts.bgAlpha ?? 1)] : [];
  if (opts.stroke) {
    f.strokes = [solid(opts.stroke, opts.strokeAlpha ?? 1)];
    f.strokeWeight = opts.strokeWeight ?? 1;
    f.strokeAlign = opts.strokeAlign || "INSIDE";
  }
  if (opts.radius !== undefined) f.cornerRadius = opts.radius;
  if (opts.clipsContent !== undefined) f.clipsContent = opts.clipsContent;
  if (opts.effects) f.effects = opts.effects;

  if (parent) {
    parent.appendChild(f);
    if (opts.flexGrow !== undefined) f.flexGrow = opts.flexGrow;
    if (opts.alignSelf) f.alignSelf = opts.alignSelf;
  }
  return f;
}
```

### 3.4 Page Switching & Creation
```javascript
let page = mg.document.children.find((p) => p.name === "Home");
if (!page) {
  page = mg.createPage();
  page.name = "Home";
}
mg.document.currentPage = page;
```

---

## 4. Common Gotchas & Troubleshooting

1. **Always `appendChild` BEFORE setting `flexGrow` or `alignSelf`**: MasterGo only accepts `flexGrow` / `alignSelf` / `layoutPositioning` on direct children of an auto-layout container (`flexMode !== 'NONE'`).
2. **Never set `fills[0].color = ...` in place**: `fills`, `strokes`, and `effects` are immutable arrays—always reassign the whole array (`node.fills = [...]`).
3. **Default white fill on new Frames**: Newly created frames may start with a default white fill; explicitly set `frame.fills = []` for transparent layout wrappers.
4. **Resize resets `mainAxisSizingMode` to `'FIXED'`**: If you want an auto-layout frame to hug contents (`'AUTO'`), set `mainAxisSizingMode = 'AUTO'` / `crossAxisSizingMode = 'AUTO'` **after** calling `resize(...)`!
5. **Empty text nodes**: `setRangeFontSize(0, 0, 16)` has an empty range—always assign `node.characters = "..."` first, then call `setRange*` over `(0, node.characters.length, ...)`.
6. **Scroll into view for the user**: End major creation scripts with `mg.viewport.scrollAndZoomIntoView([rootFrame])` so the user immediately sees the generated artboard in MasterGo.
7. **Always return JSON-serializable summaries**: Do NOT `return frame` (raw MasterGo proxy nodes don't serialize cleanly); instead return `{ id: frame.id, name: frame.name, width: frame.width, height: frame.height, children: ... }`.
8. **Single undo step**: `use_mastergo` automatically calls `mg.commitUndo()` after your script finishes, so pressing `Ctrl+Z` / `Cmd+Z` reverts the entire batch cleanly.
9. **Cloud font settling before screenshots**: When a cloud font (e.g., `Source Han Sans`) is loaded for the first time in a document, MasterGo may take a brief moment to finish glyph layout. Prefer `screenshot_node({ nodeId, scale: 1 })` for fast (~1–2s) visual checks, and re-export if newly loaded text looks unstyled on the very first frame.
10. **Plugin `postMessage` difference**: Unlike Figma (`parent.postMessage({ pluginMessage }, '*')`), MasterGo sends messages directly via `parent.postMessage(msg, '*')` and requires a non-empty numeric `id` in `manifest.json`.
