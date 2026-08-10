(function () {
  var loadedFor = '';
  var photosByKey = {};
  var availableWeeks = [];
  var attached = new WeakSet();
  var slots = ['front', 'side', 'back', 'front_flexed', 'back_flexed'];

  function slug(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  function athleteName() {
    var hero = document.querySelector('.hn, .goals-name');
    return hero && hero.textContent ? hero.textContent.trim() : '';
  }

  function athleteCode() {
    // The athlete code is the stable identity for every photo. It must come
    // from the login (URL ?code= or the saved auth code) — never the athlete's
    // display name. Returning '' when there is no real code lets callers reject
    // the action instead of filing photos under a name-derived key.
    var fromUrl = new URLSearchParams(location.search).get('code');
    var saved = localStorage.getItem('dp_auth_code');
    return slug(fromUrl || saved || '');
  }

  function activeWeek() {
    var label = document.querySelector('.wlabel, .nut-wlabel, .stitle');
    var text = label && label.textContent ? label.textContent : '';
    var match = text.match(/week\s*(\d+)/i);
    if (match) return 'week' + match[1];

    var selected = document.querySelector('[data-week].active, [data-week].selected');
    if (selected && selected.getAttribute('data-week')) {
      var selectedMatch = selected.getAttribute('data-week').match(/\d+/);
      if (selectedMatch) return 'week' + selectedMatch[0];
    }

    return availableWeeks[availableWeeks.length - 1] || 'week1';
  }

  function displayWeek() {
    var requested = activeWeek();
    var hasRequested = slots.some(function (slot) { return Boolean(photosByKey[key(requested, slot)]); });
    return hasRequested ? requested : (availableWeeks[availableWeeks.length - 1] || requested);
  }

  // Returns the week encoded in a main-grid cell's onclick (e.g. openPhotoModal(3) → 'week3')
  // Returns null for angle cells inside the modal.
  function cellGridWeek(cell) {
    var onclick = cell.getAttribute('onclick') || '';
    var match = onclick.match(/openPhotoModal\((\d+)\)/);
    return match ? 'week' + match[1] : null;
  }

  function slotForCell(cell, index) {
    var label = (cell.textContent || '').toLowerCase();
    if (label.indexOf('front flex') !== -1) return 'front_flexed';
    if (label.indexOf('back flex') !== -1) return 'back_flexed';
    if (label.indexOf('side') !== -1) return 'side';
    if (label.indexOf('back') !== -1) return 'back';
    if (label.indexOf('front') !== -1) return 'front';
    return slots[index % slots.length] || 'front';
  }

  function key(week, slot) {
    return String(week || '').toLowerCase() + ':' + String(slot || '').toLowerCase();
  }

  function setCellState(cell, photo) {
    cell.classList.toggle('has-photo', Boolean(photo));
    cell.querySelectorAll('img,.photo-overlay').forEach(function (node) { node.remove(); });

    if (!photo) return;

    var image = document.createElement('img');
    image.loading = 'lazy';
    image.alt = photo.slot + ' progress photo';
    image.src = photo.secureUrl;
    cell.prepend(image);

    var overlay = document.createElement('div');
    overlay.className = 'photo-overlay';
    overlay.textContent = photo.week || '';
    cell.appendChild(overlay);
  }

  function renderCells() {
    document.querySelectorAll('.photo-cell').forEach(function (cell, index) {
      var gridWeek = cellGridWeek(cell);

      if (gridWeek) {
        // Main photo grid cell — show the best available photo for THIS cell's specific week
        var bestSlot = slots.find(function (s) { return Boolean(photosByKey[key(gridWeek, s)]); });
        setCellState(cell, bestSlot ? photosByKey[key(gridWeek, bestSlot)] : null);
      } else {
        // Angle cell inside the modal — show by slot for the current display week
        var week = displayWeek();
        var slot = cell.getAttribute('data-cloudinary-slot') || slotForCell(cell, index);
        cell.setAttribute('data-cloudinary-slot', slot);
        setCellState(cell, photosByKey[key(week, slot)]);
      }
    });
  }

  async function loadPhotos() {
    var code = athleteCode();
    var name = athleteName();
    var loadKey = code + '|' + slug(name);

    if (!code || loadedFor === loadKey) {
      renderCells();
      return;
    }

    loadedFor = loadKey;
    photosByKey = {};
    availableWeeks = [];

    try {
      var response = await fetch('/api/progress-photos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'list', athleteCode: code, athleteName: name }),
      });
      if (!response.ok) throw new Error('Unable to load progress photos');
      var data = await response.json();
      var weekSet = new Set();
      (data.photos || []).forEach(function (photo) {
        photosByKey[key(photo.week, photo.slot)] = photo;
        if (photo.week) weekSet.add(photo.week);
      });
      availableWeeks = Array.from(weekSet).sort(function (a, b) {
        return Number((a.match(/\d+/) || [0])[0]) - Number((b.match(/\d+/) || [0])[0]);
      });
    } catch (error) {
      console.warn('[progress photos]', error.message || error);
    }

    renderCells();
  }

  function readFile(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(reader.error || new Error('Unable to read file')); };
      reader.readAsDataURL(file);
    });
  }

  async function uploadFromCell(cell) {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/jpeg,image/png,image/webp';

    input.addEventListener('change', async function () {
      var file = input.files && input.files[0];
      if (!file) return;

      // Never upload without a real athlete code — otherwise the photo would be
      // filed under a name-derived key and drift away from the athlete's data.
      var code = athleteCode();
      if (!code) {
        alert('Missing athlete code — please sign in again before adding photos.');
        return;
      }

      // Use the week encoded in the cell's onclick (main grid) or fall back to displayWeek (modal angle cell)
      var week = cellGridWeek(cell) || displayWeek();
      var slot = cell.getAttribute('data-cloudinary-slot') || 'front';
      cell.classList.add('uploading');

      try {
        var imageData = await readFile(file);
        var response = await fetch('/api/progress-photos', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'upload',
            athleteCode: code,
            athleteName: athleteName(),
            week: week,
            slot: slot,
            imageData: imageData,
          }),
        });

        var data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Upload failed');
        photosByKey[key(data.photo.week, data.photo.slot)] = data.photo;
        if (availableWeeks.indexOf(data.photo.week) === -1) availableWeeks.push(data.photo.week);
        renderCells();
      } catch (error) {
        alert(error.message || 'Progress photo upload failed');
      } finally {
        cell.classList.remove('uploading');
      }
    });

    input.click();
  }

  function attachCells() {
    document.querySelectorAll('.photo-cell').forEach(function (cell, index) {
      if (attached.has(cell)) return;
      attached.add(cell);
      // Only pre-assign a slot for angle cells (modal); main grid cells get their week from onclick
      if (!cellGridWeek(cell)) {
        cell.setAttribute('data-cloudinary-slot', slotForCell(cell, index));
      }
      cell.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        uploadFromCell(cell);
      }, true);
    });
  }

  function tick() {
    attachCells();
    loadPhotos();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tick);
  else tick();

  document.addEventListener('click', function (event) {
    if (event.target.closest('.tab,.warr,.wtoday,.nut-arr')) setTimeout(tick, 120);
  });

  new MutationObserver(function () { tick(); }).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(tick, 3000);
})();
