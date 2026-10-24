/*
 * Loaded by `mock_server.py --showcase` only. Opens the screen named in the page address
 * so a headless browser can capture it: #albums (the grid) or #settings (Slideshow
 * settings). Without a hash the slideshow plays.
 */
(function () {
  var shot = location.hash.slice(1);
  // Screenshots show finished screens: no fades or entrances that headless Chrome's
  // virtual clock can catch halfway (or leave stuck at the start).
  var style = document.createElement('style');
  style.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; }';
  document.head.appendChild(style);
  function key(code) {
    document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: code, bubbles: true }));
  }
  setTimeout(function () {
    if (shot === 'albums') key(40);
    if (shot === 'settings') {
      key(403); // red button: settings
      setTimeout(function () { key(40); key(40); key(39); }, 300); // Slideshow, into its options
    }
  }, 2500);
})();
