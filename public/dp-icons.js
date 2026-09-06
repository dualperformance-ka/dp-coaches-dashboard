/**
 * dp-icons.js
 * ---------------------------------------------------------------------------
 * One icon system for the dashboard, replacing the emoji that were rendered
 * into markup.
 *
 * Why: emoji are drawn by the operating system's colour font, so the same
 * interface looked different on a coach's Mac, their phone and a Windows
 * machine; they sit on their own baseline and never lined up with the text
 * beside them; and a colour pictogram next to monochrome UI reads as a
 * prototype. These are the same failures §27 of the product spec lists.
 *
 * Deliberately NOT replaced:
 *   - Typographic marks that are already monochrome and align on the text
 *     baseline: arrows, check and cross marks, the warning triangle. They
 *     inherit colour and font metrics, which is exactly what an icon should do.
 *   - The pride theme button. A monochrome glyph would not mean anything there.
 *   - Emoji inside copy the coach sends to an athlete (the DM templates). That
 *     is outgoing message text, not interface chrome.
 *
 * Follows the pattern already established in dashboard-mobilenav.js: one 24x24
 * viewBox, currentColor stroke, no fill, so an icon takes the colour and size
 * of whatever it sits in.
 *
 * Usage:
 *   DP_ICON('trophy')                 default 1em, inherits colour
 *   DP_ICON('bell', { size: 14 })
 *   DP_ICON('flag', { label: 'Race' }) adds an accessible name
 *
 * An icon is decorative by default (aria-hidden) because it almost always sits
 * beside its own text label. Pass `label` only where the icon is the only
 * thing carrying the meaning.
 */
(function () {
  'use strict';

  // 24x24, 1.75 stroke, round caps. Paths only: the wrapper supplies the rest.
  var ICONS = {
    trophy:    '<path d="M7 4h10v5a5 5 0 0 1-10 0V4Z"/><path d="M7 6H4.5A2.5 2.5 0 0 0 7 8.5"/><path d="M17 6h2.5A2.5 2.5 0 0 1 17 8.5"/><path d="M12 14v3"/><path d="M8.5 20h7"/><path d="M10 17h4v3h-4z"/>',
    trend:     '<path d="M3 17.5 9 11l4 4 8-8.5"/><path d="M15 6.5h6v6"/>',
    clipboard: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1"/><path d="M8.5 10h7M8.5 14h7M8.5 18h4"/>',
    note:      '<path d="M5 5.5A1.5 1.5 0 0 1 6.5 4H15l4 4v10.5A1.5 1.5 0 0 1 17.5 20h-11A1.5 1.5 0 0 1 5 18.5Z"/><path d="M14.5 4v4.5H19"/><path d="M8.5 13h7M8.5 16.5h4"/>',
    message:   '<path d="M4 6.5A1.5 1.5 0 0 1 5.5 5h13A1.5 1.5 0 0 1 20 6.5v8a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 3.5V16h-.5A1.5 1.5 0 0 1 4 14.5Z"/>',
    flame:     '<path d="M12 3s4.5 3.8 4.5 8.2a4.5 4.5 0 0 1-9 0C7.5 9 9 7.5 9 7.5s.5 2 1.75 2C12 9.5 12 6.5 12 3Z"/><path d="M12 21a5 5 0 0 0 5-5"/><path d="M12 21a5 5 0 0 1-5-5"/>',
    target:    '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1"/>',
    flag:      '<path d="M5.5 21V4"/><path d="M5.5 5h13l-2.5 4 2.5 4h-13"/>',
    bell:      '<path d="M18 9a6 6 0 0 0-12 0c0 5-2 6-2 6h16s-2-1-2-6Z"/><path d="M13.7 19a2 2 0 0 1-3.4 0"/>',
    siren:     '<path d="M12 3v2M5 8 3.5 6.8M19 8l1.5-1.2"/><path d="M6.5 20v-6a5.5 5.5 0 0 1 11 0v6Z"/><path d="M4.5 20h15"/>',
    calendar:  '<rect x="4" y="5.5" width="16" height="15" rx="2"/><path d="M8 3.5v4M16 3.5v4M4 10h16"/>',
    pin:       '<path d="M12 21s6.5-5.6 6.5-10.5a6.5 6.5 0 1 0-13 0C5.5 15.4 12 21 12 21Z"/><circle cx="12" cy="10.5" r="2.5"/>',
    moon:      '<path d="M20 13.5A8 8 0 0 1 10.5 4a8 8 0 1 0 9.5 9.5Z"/>',
    gauge:     '<path d="M4.5 17a8 8 0 1 1 15 0"/><path d="M12 17l4-4.5"/><circle cx="12" cy="17" r="1.2"/>',
    dumbbell:  '<path d="M3 10.5v3M6.5 8v8M17.5 8v8M21 10.5v3M6.5 12h11"/>',
    footprint: '<path d="M8 5.5c1.6 0 2.5 1.4 2.5 3.4S9.6 13 8 13s-2.5-1.6-2.5-3.6S6.4 5.5 8 5.5Z"/><path d="M5.5 15.5h5v2a2.5 2.5 0 0 1-5 0Z"/><path d="M16.5 9c1.3 0 2 1.1 2 2.7s-.7 3-2 3-2-1.4-2-3 .7-2.7 2-2.7Z"/><path d="M14.5 17h4v1.5a2 2 0 0 1-4 0Z"/>',
    utensils:  '<path d="M7 3v8M5 3v4a2 2 0 0 0 4 0V3M7 11v10"/><path d="M17 21V3s-2.5 1.5-2.5 6 2.5 4 2.5 4"/>',
    run:       '<circle cx="15" cy="5" r="1.8"/><path d="M13.5 9.2 10 11l1.5 3.5L9 21"/><path d="M13.5 9.2 17 11l1 4"/><path d="M10 11 6 10.5"/>',
    bolt:      '<path d="M13.5 3 6 13.5h5L10.5 21 18 10.5h-5Z"/>',
    dot:       '<circle cx="12" cy="12" r="5" fill="currentColor" stroke="none"/>',
  };

  function icon(name, options) {
    var opts = options || {};
    var paths = ICONS[name];
    if (!paths) return '';
    var size = opts.size ? opts.size + 'px' : '1em';
    var accessible = opts.label
      ? 'role="img" aria-label="' + String(opts.label).replace(/"/g, '&quot;') + '"'
      : 'aria-hidden="true" focusable="false"';
    return '<svg class="dp-icon' + (opts.className ? ' ' + opts.className : '') + '"' +
      ' width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none"' +
      ' stroke="currentColor" stroke-width="1.75" stroke-linecap="round"' +
      ' stroke-linejoin="round" ' + accessible + '>' + paths + '</svg>';
  }

  icon.names = Object.keys(ICONS);
  window.DP_ICON = icon;
})();
