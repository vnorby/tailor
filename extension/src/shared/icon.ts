// Wallet icon (data URI, required by Wallet Standard): tape-yellow T on charcoal.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" rx="28" fill="#141416"/><path d="M30 40h68v14H71v46H57V54H30z" fill="#e8c547"/><path d="M30 108h68" stroke="#e8c547" stroke-width="3" stroke-dasharray="2 6"/></svg>`;
export const ICON = `data:image/svg+xml;base64,${btoa(svg)}` as const;
export const ICON_SVG = svg;
