// File: bandColor.js → ~/Projects/podiumnotes/lib/bandColor.js
//
// One definition of how the band's colour is rendered, shared by the
// presenter and by Settings.
//
// This exists because they disagreed. The presenter drew the band as a 15%
// fill with a 75% border, while Settings drew the swatch as a solid block of
// the raw hex — so a swatch that looked like a confident blue produced a band
// so faint it read as a different colour, and the only way to get the band
// you wanted was to pick a swatch you didn't. Same numbers, one place.

export const BAND_FILL_ALPHA = 0.15;    // large area behind text
export const BAND_BORDER_ALPHA = 0.75;  // the outline that gives it an edge
export const CLEAR_GREY = '#94a3b8';    // stand-in for the 'clear' option

// Any alpha of a band colour. `hex` is '#rrggbb' or the string 'clear'.
export function bandAlphaColor(hex, alpha) {
  if (!hex || hex === 'clear') {
    const r = parseInt(CLEAR_GREY.slice(1, 3), 16);
    const g = parseInt(CLEAR_GREY.slice(3, 5), 16);
    const b = parseInt(CLEAR_GREY.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// The band's interior.
export function bandFillColor(hex) {
  if (hex === 'clear') return 'transparent';
  return bandAlphaColor(hex, BAND_FILL_ALPHA);
}

// The band's outline. Hex+alpha rather than rgba() so it stays identical to
// what the presenter shipped before this was centralised.
export function bandBorderColor(hex) {
  if (hex === 'clear') return CLEAR_GREY;
  return hex + 'BF';
}

// Mix a band colour toward white.
//
// The palette is designed for a band sitting BEHIND dark text on a light
// page, so the colours are dark by construction. On a dark track they have
// nowhere to go: the default green measured 1.49 contrast against the dark
// track at the bar's normal opacity, below the 1.68 that reads fine in light
// mode, and raising opacity alone only reached 2.92. Lightening first gives
// the colour somewhere to move.
export function lightenHex(hex, t) {
  if (!hex || hex === 'clear') return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const m = (c) => Math.round(c + (255 - c) * t);
  return `#${[m(r), m(g), m(b)].map(v => v.toString(16).padStart(2, '0')).join('')}`;
}
