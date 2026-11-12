'use strict';
// The Chairminus mark: a chair and a minus sign. Used by the welcome screen and the app icon.
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
<defs><linearGradient id="cm-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2dd4bf"/><stop offset="1" stop-color="#4f46e5"/></linearGradient></defs>
<rect x="100" y="100" width="824" height="824" rx="185" fill="url(#cm-g)"/>
<g fill="none" stroke="#fff" stroke-width="64" stroke-linecap="round" stroke-linejoin="round"><path d="M360 280V600H664V760"/><path d="M360 600V760"/></g>
<rect x="520" y="372" width="170" height="60" rx="30" fill="#fff" opacity=".92"/></svg>`;

module.exports = { LOGO_SVG };
