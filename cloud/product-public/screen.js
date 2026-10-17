(function () {
  'use strict';
  var ui = window.DisplayOSUI;
  var root = document.getElementById('screen-root');
  var status = document.getElementById('screen-status');
  var screenInfo = { identifier: '', screenName: '', homeName: '', allowEdits: false };
  var currentWeekByDate = {};
  var TILE_ICONS = { 'This week': '📅', 'For the kids': '🧒', 'Little reminders': '🔔', 'For the grown-ups': '💛', 'A little of the world': '🌍', 'Around the table': '💬', 'Around town': '📍', 'Family lists': '🛒' };
  var listFilter = 'all';
  function tileIcon(title) { return TILE_ICONS[title] || '✨'; }
  function weatherEmoji(condition) {
    var text = String(condition || '').toLowerCase();
    if (/sun|clear|fair/.test(text)) return '☀️';
    if (/thunder|storm/.test(text)) return '⛈️';
    if (/rain|shower|drizzle/.test(text)) return '🌧️';
    if (/snow|flurr|blizzard/.test(text)) return '❄️';
    if (/fog|mist|haze/.test(text)) return '🌫️';
    if (/cloud|overcast/.test(text)) return '☁️';
    if (/wind|breez|gust/.test(text)) return '🍃';
    return '🌤️';
  }
  var envelope = null;
  var pairing = null;
  var pairingInFlight = false;
  var lastRender = '';
  var lastActivity = Date.now();
  var quiet = false;
  var night = false;
  var quietHoursOverride = false;
  var loadingFullDisplay = false;
  var fullDisplayAfterPoll = 0;
  var pollNumber = 0;
  var localNotice = '';
  var photos = {};
  var photoIndex = 0;
  var photoTick = 0;
  var ackPending = null;
  var token = null;
  var demoKey = null;
  var recoveryAt = 0;
  var closeSheet = null;
  var displayState = 'starting';
  var failedPolls = 0;
  var pollTimer = null;
  var localData = null;
  var localGeneration = 0;
  var localInFlight = null;
  var localNextAt = 0;
  var localFailures = 0;
  var localConfig = '';
  var localEnabled = { weather: false, nearby: false };
  var localRevision = 0;
  var localPollReady = false;
  try { token = sessionStorage.getItem('displayos-demo-device-token'); } catch (_) {}
  try { demoKey = JSON.parse(sessionStorage.getItem('displayos-demo-device-key')); } catch (_) {}
  var SCENE_KIND_ICONS = { answer: '🎯', plan: '📅', list: '🛒', compare: '⚖️', steps: '🧭', note: '📝', timer: '⏱️' };
  var VOICE_AGENT_KEY = 'displayos-voice-agent';
  var SAGE_BEAM = ['#f2f6f4', '#d5e2dd', '#b8cdc5', '#9bb8ad', '#7fa396', '#678c80', '#527268'];
  var SAGE_BAND = { core: '#ffffff', above: '#d5e2dd', mid: '#9bb8ad', below: '#678c80' };
  var VOICE_FAST_WINDOW = 45000;
  var voiceState = 'idle';
  var voiceStateText = 'Hold to talk';
  var voiceDock = null;
  var voiceTalk = null;
  var voiceAgentsBox = null;
  var voiceStatusLine = null;
  var voiceBeam = null;
  var voiceStream = null;
  var voiceAudio = null;
  var voiceAnalyser = null;
  var voiceFreq = null;
  var voiceMeterFrame = 0;
  var voiceRecorder = null;
  var voiceChunks = [];
  var voiceMime = 'audio/webm';
  var voiceStartedAt = 0;
  var voiceDurationMs = 0;
  var voiceTick = 0;
  var voiceReset = 0;
  var captureGeneration = 0;
  var voicePending = null;
  var voicePendingAt = 0;
  var voiceFastUntil = 0;
  var voiceToast = null;
  var voiceToastAt = 0;
  var voiceToastPinned = false;
  var dismissedSceneIds = {};
  var voiceAgents = [];
  var voiceView = null;
  var voiceSheetOpen = false;
  function device(path, body, blob) { return ui.request(path, { method: body === undefined ? 'GET' : 'POST', body: body, blob: blob, deviceToken: token }); }
  function timestamp(value) { return typeof value === 'number' ? value : Date.parse(value); }
  function valid() { return envelope && envelope.snapshot && timestamp(envelope.snapshot.expiresAt || envelope.expiresAt) > Date.now(); }
  function settings() { return envelope && envelope.settings || { timezone: 'UTC', quietAfterSeconds: 120, nightStart: '22:00', nightEnd: '07:00', showPhotos: true }; }
  function isNight(current) {
    var time = ui.dateParts(current.timezone || 'UTC');
    var minute = time.hour * 60 + time.minute;
    function clockMinute(value) { var parts = String(value || '').split(':'); return Number(parts[0]) * 60 + Number(parts[1]); }
    var start = clockMinute(current.nightStart || '22:00');
    var end = clockMinute(current.nightEnd || '07:00');
    return start === end ? false : start > end ? minute >= start || minute < end : minute >= start && minute < end;
  }
  function localEligible() { return displayState === 'owned' && localPollReady && envelope && !night && navigator.onLine !== false && !document.hidden && (localEnabled.weather || localEnabled.nearby); }
  function localValid() { return localData && localEligible() && localData.expiresAt > Date.now(); }
  function clearLocal() { localData = null; localGeneration++; localInFlight = null; }
  function syncLocal(value) {
    var enabled = value.localEnabled || {};
    var revision = typeof value.localRevision === 'number' && isFinite(value.localRevision) ? value.localRevision : 0;
    var key = JSON.stringify([revision, enabled.weather === true, enabled.nearby === true]);
    var changed = key !== localConfig;
    if (changed) { clearLocal(); localNextAt = 0; localFailures = 0; localNotice = ''; }
    localConfig = key; localRevision = revision;
    localEnabled = { weather: enabled.weather === true, nearby: enabled.nearby === true };
    localPollReady = true;
    return changed;
  }
  function localResult(value) {
    if (!value || value.localRevision !== localRevision || !value.localEnabled || value.localEnabled.weather !== localEnabled.weather || value.localEnabled.nearby !== localEnabled.nearby) throw new Error('Local choices changed');
    if (value.available === false) return null;
    var now = Date.now();
    var expiry = value.expiresAt;
    if (value.available !== true || value.ephemeral !== true || value.attribution !== 'Google Maps' || !Array.isArray(value.thirdPartyAttributions) || value.thirdPartyAttributions.length || typeof expiry !== 'number' || !isFinite(expiry) || expiry <= now || expiry > now + 3630000) throw new Error('Local information is unavailable');
    function text(value, limit) { if (typeof value !== 'string' || value.length > limit) throw new Error('Local text is unavailable'); return value; }
    if (!Array.isArray(value.weather) || value.weather.length > 7 || !Array.isArray(value.nearby) || value.nearby.length > 3) throw new Error('Local information is unavailable');
    var weather = localEnabled.weather ? value.weather.map(function (day) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day.date) || typeof day.high !== 'number' || typeof day.low !== 'number' || !isFinite(day.high) || !isFinite(day.low) || day.low < -100 || day.high > 100 || day.low > day.high) throw new Error('Local forecast is unavailable');
      return { date: day.date, label: text(day.label, 80), condition: text(day.condition, 80), high: day.high, low: day.low };
    }) : [];
    if (weather.length && value.weatherSourceAttribution !== 'Source: Includes weather data from Google') throw new Error('Local source is unavailable');
    var nearby = localEnabled.nearby ? value.nearby.map(function (place) { return { title: text(place.title, 80), when: text(place.when, 80) }; }) : [];
    return { weather: weather, nearby: nearby, cityLabel: text(value.cityLabel, 80), expiresAt: Math.min(expiry, now + 3600000) };
  }
  function fetchLocal() {
    if (!localEligible() || localInFlight !== null || Date.now() < localNextAt) return;
    var generation = localGeneration;
    var currentToken = token;
    localInFlight = generation;
    localNextAt = Date.now() + 3300000 + Math.floor(Math.random() * 60000);
    localNotice = 'Checking weather and nearby places...';
    render(true);
    device('/device/v1/local').then(function (value) {
      if (generation !== localGeneration || currentToken !== token || !localEligible()) return;
      localData = localResult(value); localFailures = 0; localNotice = ''; render(true);
    }).catch(function () {
      if (generation !== localGeneration || currentToken !== token) return;
      clearLocal(); localFailures++;
      localNotice = 'Weather and nearby places could not be loaded. We will try again shortly.';
      localNextAt = Date.now() + Math.min(3600000, 300000 * Math.pow(2, Math.min(localFailures - 1, 4)));
      if (envelope && displayState === 'owned') render(true);
    }).finally(function () { if (localInFlight === generation) localInFlight = null; });
  }
  function wipe(preserveLocal) {
    if (!preserveLocal) { clearLocal(); localPollReady = false; localConfig = ''; localEnabled = { weather: false, nearby: false }; }
    if (closeSheet) closeSheet();
    Object.keys(photos).forEach(function (key) { URL.revokeObjectURL(photos[key]); });
    photos = {}; envelope = null; ackPending = null; lastRender = ''; photoIndex = 0;
    voiceToast = null; voiceToastPinned = false; voicePending = null; voiceView = null;
    updateVoiceDock();
    ui.clear(root);
  }
  function panel(title, detail, children) {
    ui.clear(root);
    root.className = 'screen-shell';
    var split = (children || []).some(function (child) { return child && child.className === 'qr'; });
    root.appendChild(ui.node('section', { className: 'pair-panel' + (split ? ' pair-panel-split' : '') }, [ui.node('p', { className: 'eyebrow', text: 'DisplayOS' }), ui.node('h1', { text: title }), ui.node('p', { text: detail })].concat(children || [])));
    if (token) root.appendChild(ui.node('p', { className: 'demo-banner', text: 'Browser trial. This screen closes when you close this tab.' }));
  }
  function qr(code) {
    var link = location.origin + '/home#claim=' + encodeURIComponent(code);
    var matrix = window.qrcode(0, 'M'); matrix.addData(link); matrix.make();
    var count = matrix.getModuleCount();
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 ' + count + ' ' + count);
    svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Scan to add this screen to your home');
    var shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    var path = '';
    for (var row = 0; row < count; row++) for (var column = 0; column < count; column++) if (matrix.isDark(row, column)) path += 'M' + column + ',' + row + 'h1v1h-1z';
    shape.setAttribute('d', path); shape.setAttribute('fill', '#0a0a0b'); svg.appendChild(shape);
    return ui.node('div', { className: 'qr' }, [svg]);
  }
  function showPairing() {
    if (!pairing || timestamp(pairing.expiresAt) <= Date.now()) { panel('Make yourself at home.', 'Getting a fresh code for your phone...'); return; }
    var children = [];
    if (typeof window.qrcode === 'function') children.push(qr(pairing.code));
    children.push(ui.node('p', { text: 'Open DisplayOS on your phone, or scan this square with your camera.' }));
    var manual = String(pairing.manualCode || pairing.code);
    var shortCode = /^[0-9]{6}$/.test(manual);
    children.push(ui.node('span', { className: 'pair-code', text: shortCode ? manual.slice(0, 3) + ' ' + manual.slice(3) : manual, 'aria-label': (shortCode ? 'Six numbers on your screen: ' : 'Screen code: ') + manual.split('').join(' ') }));
    children.push(ui.node('p', { className: 'pair-countdown', role: 'timer', 'aria-live': 'off' }));
    children.push(ui.node('p', { className: 'muted', text: 'Keep this code between you and your family. It changes shortly.' }));
    panel('Make yourself at home.', 'Add this screen to your home.', children);
    tickPairing();
  }
  function tickPairing() {
    var countdown = root.querySelector('.pair-countdown');
    if (!countdown || !pairing) return;
    var seconds = Math.max(0, Math.ceil((timestamp(pairing.expiresAt) - Date.now()) / 1000));
    countdown.textContent = 'This code changes in ' + Math.floor(seconds / 60) + ':' + ('0' + seconds % 60).slice(-2) + '.';
  }
  function getPairing() {
    if (pairingInFlight) return;
    pairingInFlight = true;
    device('/device/v1/pairing', {}).then(function (value) { pairing = value; showPairing(); status.textContent = ''; }).catch(function (error) { status.textContent = ui.message(error); }).finally(function () { pairingInFlight = false; });
  }
  function clockNodes() { return [ui.node('div', { className: 'clock', 'data-clock': '' }), ui.node('div', { className: 'clock-date', 'data-date': '' })]; }
  function heading(icon, label) {
    var brand = ui.node('span', { className: 'brand', text: envelope && envelope.homeName || screenInfo.homeName || 'DisplayOS' });
    var shown = envelope && envelope.screenName || screenInfo.screenName;
    if (shown) brand.appendChild(ui.node('span', { className: 'screen-name', text: shown }));
    var viewButton = ui.node('button', { type: 'button', className: 'button secondary' }, [ui.node('span', { 'aria-hidden': 'true', text: icon + ' ' }), ui.node('span', { text: label })]);
    viewButton.addEventListener('click', function () { quiet = !quiet; lastActivity = Date.now(); render(); });
    var settingsButton = ui.button('⚙️ Settings', function () { openSettings(); }, true);
    settingsButton.setAttribute('aria-label', 'Open screen settings');
    settingsButton.className += ' settings-button';
    var controls = ui.node('div', { className: 'screen-controls' }, [viewButton, settingsButton]);
    var bar = ui.node('header', { className: 'screen-bar' }, [brand, controls]);
    return bar;
  }
  function tile(title, children, className) {
    var icon = tileIcon(title);
    var head = ui.node('div', { className: 'tile-heading' }, [ui.node('span', { className: 'tile-icon', 'aria-hidden': 'true', text: icon }), ui.node('h2', { text: title })]);
    var section = ui.node('section', { className: 'family-tile ' + (className || '') }, [head].concat(children));
    section.setAttribute('tabindex', '0');
    section.setAttribute('role', 'button');
    section.setAttribute('aria-label', 'Open ' + title);
    section.addEventListener('click', function (event) { if (event.target.closest && event.target.closest('button')) return; expandTile(section); });
    section.addEventListener('keydown', function (event) { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); expandTile(section); } });
    return section;
  }
  function empty(text) { return ui.node('p', { className: 'muted', text: text }); }
  function localAttribution(weatherSource) {
    var parts = [ui.node('span', { className: 'attribution-brand', translate: 'no', text: 'Google Maps' })];
    if (weatherSource) parts.push(' · ', ui.node('span', { translate: 'no', text: 'Source: Includes weather data from Google' }));
    return ui.node('p', { className: 'local-attribution' }, parts);
  }
  function focusables(box) {
    return Array.prototype.filter.call(box.querySelectorAll('button, [href], [tabindex]:not([tabindex="-1"])'), function (element) { return !element.disabled && element.offsetParent !== null; });
  }
  function openSheet(title, icon, bodyNodes, hint) {
    if (closeSheet) closeSheet();
    var focus = document.activeElement;
    var content = ui.node('div', { className: 'screen-sheet-body', tabindex: '0', 'aria-label': title });
    (bodyNodes || []).forEach(function (child) { content.appendChild(child); });
    var close = ui.button('Back to our day', function () { closeSheet(); }, true);
    var titleNode = ui.node('h2', { id: 'screen-sheet-title', text: title });
    if (icon) titleNode.insertBefore(ui.node('span', { 'aria-hidden': 'true', text: icon + ' ' }), titleNode.firstChild);
    var headingRow = ui.node('div', { className: 'screen-sheet-heading' }, [titleNode, close]);
    var card = ui.node('section', { className: 'screen-sheet-card' }, [headingRow, ui.node('p', { className: 'muted', text: hint || 'Tap a day or card to explore. Scroll to see everything. 🎈' }), content]);
    var dialog = ui.node('div', { className: 'screen-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'screen-sheet-title' }, [card]);
    root.setAttribute('aria-hidden', 'true');
    function key(event) {
      if (event.key === 'Escape') { event.preventDefault(); closeSheet(); return; }
      if (event.key === 'Tab') {
        var items = focusables(dialog);
        if (!items.length) { event.preventDefault(); return; }
        var first = items[0]; var last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    }
    dialog.addEventListener('click', function (event) { if (event.target === dialog) closeSheet(); });
    document.addEventListener('keydown', key);
    closeSheet = function () { dialog.remove(); root.removeAttribute('aria-hidden'); document.removeEventListener('keydown', key); closeSheet = null; voiceSheetOpen = false; updateVoiceDock(); if (focus && root.contains(focus)) focus.focus(); };
    document.body.appendChild(dialog); voiceSheetOpen = true; updateVoiceDock(); close.focus();
    return { dialog: dialog, body: content, close: close };
  }
  function rebindDayButtons(scope) {
    Array.prototype.forEach.call(scope.querySelectorAll('[data-day-date]'), function (button) {
      button.addEventListener('click', function (event) { event.stopPropagation(); openDay(button.getAttribute('data-day-date')); });
    });
  }
  function expandTile(tileElement) {
    var title = tileElement.querySelector('h2').textContent;
    var icon = tileIcon(title);
    var content = ui.node('div', {}, []);
    if (tileElement.classList.contains('lists-tile') && tileElement._lists) {
      var editable = screenInfo.allowEdits === true && valid() && !!envelope.snapshot;
      paintListsTile(content, tileElement._lists, true, editable);
      if (!editable) content.insertBefore(ui.node('p', { className: 'muted', text: 'Ask an owner to allow editing from this screen to add items here.' }), content.firstChild);
      var hint = content.querySelector('.tile-hint');
      if (hint) hint.remove();
    } else {
    Array.prototype.forEach.call(tileElement.children, function (child) {
      if (child.classList && (child.classList.contains('tile-heading') || child.classList.contains('tile-expand') || child.classList.contains('tile-hint') || child.classList.contains('list-filters'))) return;
      if (child.tagName === 'H2') return;
      content.appendChild(child.cloneNode(true));
    });
    }
    var sheet = openSheet(title, icon, [content], title === 'This week' ? 'Pick a day to see its plans. 🎉' : 'Everything in ' + title + ', all in one cozy place. 💛');
    rebindDayButtons(sheet.body);
  }
  function offerFullCards() {
    requestAnimationFrame(function () {
      Array.prototype.forEach.call(root.querySelectorAll('.family-tile'), function (tileElement) {
        var previous = tileElement.querySelector('.tile-expand');
        if (previous) previous.remove();
        tileElement.classList.remove('has-more');
        if (tileElement.scrollHeight > tileElement.clientHeight + 2) tileElement.classList.add('has-more');
        var title = tileElement.querySelector('h2').textContent;
        var control = ui.button(title === 'This week' ? 'See all 👀' : 'Open 👀', function (event) { if (event.stopPropagation) event.stopPropagation(); expandTile(tileElement); }, true);
        control.className = 'tile-expand tile-expand-visible'; control.setAttribute('aria-label', 'See all ' + title);
        var headingRow = tileElement.querySelector('.tile-heading');
        (headingRow || tileElement).appendChild(control);
        var hint = tileElement.querySelector('.tile-hint');
        if (!hint) { hint = ui.node('span', { className: 'tile-hint', text: 'Tap to open 👀' }); tileElement.appendChild(hint); }
      });
    });
  }
  function screenListId() {
    var bytes = crypto.getRandomValues(new Uint8Array(9));
    var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    var id = '';
    for (var index = 0; index < bytes.length; index++) id += alphabet.charAt(bytes[index] % alphabet.length);
    return id;
  }
  function editLists(body, again) {
    if (!valid() || !envelope.snapshot) return;
    body.expectedRevision = envelope.revision;
    device('/device/v1/lists', body).then(function () { status.textContent = 'List updated ✓'; poll(); }).catch(function (error) {
      if (error && error.status === 409 && !again) { poll(); window.setTimeout(function () { editLists(body, true); }, 800); return; }
      if (error && error.status === 403) { screenInfo.allowEdits = false; render(true); status.textContent = 'List editing is not allowed from this screen.'; return; }
      status.textContent = ui.message(error); poll();
    });
  }
  function dayDetails(date) {
    var entry = currentWeekByDate[date];
    if (entry) return entry;
    return { date: date, events: [], forecast: null };
  }
  function dayLongLabel(value) {
    var parsed = new Date(value + 'T12:00:00Z');
    return isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' });
  }
  function openDay(date) {
    var details = dayDetails(date);
    var title = dayLongLabel(date);
    var nodes = [];
    if (details.forecast) {
      nodes.push(ui.node('p', { className: 'day-forecast', text: weatherEmoji(details.forecast.condition) + ' ' + ui.temperatureRange(details.forecast.low, details.forecast.high, settings().temperatureUnit) + ' · ' + details.forecast.condition }));
      if (localValid() && localData.weather.some(function (day) { return day.date === date; })) nodes.push(localAttribution(true));
    }
    if (details.events && details.events.length) {
      nodes.push(ui.node('ul', { className: 'day-events' }, details.events.map(function (event) {
        return ui.node('li', {}, [ui.node('span', { className: 'day-event-emoji', 'aria-hidden': 'true', text: '⭐' }), ui.node('div', {}, [ui.node('strong', { text: event.title || 'Family time' }), ui.node('p', { className: 'muted', text: [event.time ? '🕘 ' + event.time : '', event.person ? '👪 ' + event.person : ''].filter(Boolean).join('   ') || 'Have fun together! 🎈' })])]);
      })));
    } else {
      nodes.push(ui.node('p', { className: 'day-empty', text: '🎈 Nothing planned yet. Perfect for something spontaneous!' }));
      nodes.push(ui.node('p', { className: 'muted', text: 'Ask your helper to add plans and they will show up here. 💛' }));
    }
    openSheet(title, '📅', nodes, 'One day, all its little plans. ✨');
  }
  function openSettings() {
    var nodes = [];
    nodes.push(ui.node('h3', { text: '📺 This screen' }));
    nodes.push(ui.node('p', {}, [ui.node('strong', { text: screenInfo.screenName || envelope && envelope.screenName || 'Family screen' })]));
    if (screenInfo.identifier) nodes.push(ui.node('p', { className: 'settings-id', text: '🔑 Screen ' + screenInfo.identifier }));
    nodes.push(ui.node('p', { className: 'muted', text: '🏠 ' + (screenInfo.homeName || envelope && envelope.homeName || 'DisplayOS') }));
    if (token) nodes.push(ui.node('p', { className: 'demo-banner', text: '🧪 Browser trial. This screen closes when you close this tab.' }));
    nodes.push(ui.node('h3', { text: '👀 View controls' }));
    var viewRow = ui.node('div', { className: 'settings-row' }, [
      ui.button(quiet ? '🌞 Show our day' : '🌙 Quiet view', function () { quiet = !quiet; lastActivity = Date.now(); closeSheet(); render(); }, true),
      quietHoursOverride ? ui.button('🔔 Back to quiet hours', function () { closeSheet(); restoreQuietHours(); }, true) : null
    ]);
    nodes.push(viewRow);
    nodes.push(ui.node('p', { className: 'muted', text: '🌙 Quiet hours hide weather and family info to keep nights calm.' }));
    if (status.textContent) nodes.push(ui.node('p', { className: 'muted', text: '💬 ' + status.textContent }));
    if (localNotice) nodes.push(ui.node('p', { className: 'muted', text: '📡 ' + localNotice }));
    openSheet('Screen settings', '⚙️', nodes, 'Screen name, view and quiet hours live here. 🔧');
  }
  function listItemRow(item) {
    var row = ui.node('li', { className: 'list-item' + (item.done ? ' is-done' : '') });
    row.appendChild(ui.node('span', { className: 'list-check', 'aria-hidden': 'true', text: item.done ? '✅' : '○' }));
    var copy = ui.node('div', { className: 'row-copy' }, [ui.node('strong', { text: item.text })]);
    if (item.person) copy.appendChild(ui.node('span', { text: '👪 ' + item.person }));
    row.appendChild(copy);
    return row;
  }
  function listEditRow(entry, item) {
    var box = ui.node('input', { type: 'checkbox', checked: item.done === true, 'aria-label': 'Done: ' + item.text });
    box.addEventListener('change', function () { editLists({ listId: entry.id, action: 'toggle', itemId: item.id }); });
    var label = ui.node('label', { className: 'list-edit-label' }, [box, ui.node('span', { text: item.text + (item.person ? ' · ' + item.person : '') })]);
    var row = ui.node('div', { className: 'list-edit-row' + (item.done ? ' is-done' : '') }, [label]);
    var remove = ui.button('Remove', function (event) { if (event.stopPropagation) event.stopPropagation(); editLists({ listId: entry.id, action: 'remove', itemId: item.id }); }, true);
    remove.className += ' list-remove';
    row.appendChild(remove);
    return row;
  }
  function paintListsTile(section, lists, full, editable) {
    section._lists = lists || [];
    section._editable = editable === true;
    Array.prototype.forEach.call(section.querySelectorAll('.list-filters, .lists-body'), function (node) { node.remove(); });
    var shown = (lists || []).filter(function (entry) { return full || listFilter === 'all' || entry.kind === listFilter; });
    var filters = full ? null : ui.node('div', { className: 'list-filters', role: 'group', 'aria-label': 'Filter lists' }, [['all', 'All ✨'], ['groceries', '🛒'], ['todo', '✅']].map(function (option) {
      var button = ui.button(option[1], function (event) { if (event.stopPropagation) event.stopPropagation(); listFilter = option[0]; paintListsTile(section, lists, false, section._editable); }, true);
      button.setAttribute('aria-label', 'Show ' + (option[0] === 'all' ? 'all lists' : option[0] === 'groceries' ? 'groceries' : 'to-dos'));
      button.setAttribute('aria-pressed', String(listFilter === option[0]));
      if (listFilter === option[0]) button.className += ' is-active';
      return button;
    }));
    if (filters) section.appendChild(filters);
    var body = ui.node('div', { className: 'lists-body' });
    if (!shown.length) body.appendChild(empty(listFilter === 'all' || full ? '🛒 No lists yet. Add groceries or to-dos from home.' : '🎈 Nothing here. Try another filter.'));
    shown.slice(0, full ? shown.length : 4).forEach(function (entry) {
      var ordered = (entry.items || []).slice().sort(function (left, right) { return (left.done ? 1 : 0) - (right.done ? 1 : 0); });
      var block = ui.node('div', { className: 'family-list' }, [ui.node('h3', { text: (entry.kind === 'groceries' ? '🛒 ' : '✅ ') + entry.title })]);
      if (!ordered.length && !editable) block.appendChild(empty('🎈 Empty for now.'));
      else if (editable) ordered.forEach(function (item) { block.appendChild(listEditRow(entry, item)); });
      else {
        block.appendChild(ui.node('ul', { className: 'check-list' }, (full ? ordered : ordered.slice(0, 3)).map(listItemRow)));
        if (!full && ordered.length > 3) block.appendChild(ui.node('p', { className: 'more-hint', text: '+' + (ordered.length - 3) + ' more — tap to see 👀' }));
      }
      if (editable) {
        var textInput = ui.node('input', { type: 'text', maxlength: '80', placeholder: 'Add milk...', 'aria-label': 'New item for ' + entry.title });
        var personInput = ui.node('input', { type: 'text', maxlength: '80', placeholder: 'For whom (optional)', 'aria-label': 'Who is the item for' });
        var add = ui.button('Add', function () {
          var text = textInput.value.trim();
          if (!text) { textInput.focus(); return; }
          var item = { id: screenListId(), text: text };
          if (personInput.value.trim()) item.person = personInput.value.trim();
          status.textContent = 'Adding to ' + entry.title + '...';
          editLists({ listId: entry.id, action: 'add', item: item });
        }, true);
        block.appendChild(ui.node('div', { className: 'list-edit-add' }, [textInput, personInput, add]));
      }
      body.appendChild(block);
    });
    section.appendChild(body);
    if (!section.querySelector('.tile-hint')) section.appendChild(ui.node('span', { className: 'tile-hint', text: 'Tap to open 👀' }));
  }
  function listsTile(lists) {
    var section = tile('Family lists', [], 'lists-tile');
    paintListsTile(section, lists || []);
    return section;
  }
  function personRows(people) {
    if (!people.length) return [empty('🎈 Nothing to catch up on here.')];
    return people.map(function (person) { return ui.node('div', {}, [ui.node('h3', { text: person.name }), ui.node('ul', {}, person.items.map(function (item) { return ui.node('li', { text: item }); }))]); });
  }
  function dayLabel(value) {
    var parsed = new Date(value + 'T12:00:00Z');
    return isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', day: 'numeric' });
  }
  function ourDay() {
    var data = valid() ? envelope.snapshot : { briefing: { title: 'A little closer to home.', text: 'Your chosen local weather and places. Your helper can add family plans.' } };
    root.className = 'screen-shell has-day';
    root.appendChild(heading('🌙', 'Quiet view'));
    voiceView = 'our-day';
    ensureVoiceDock();
    var localWeather = localValid() && localData.weather.length > 0;
    var localNearby = localValid() && localData.nearby.length > 0;
    var weather = localWeather ? localData.weather : data.weather || [];
    var todayEmoji = weather.length ? weatherEmoji(weather[0].condition) : '🌤️';
    var weatherNow = weather.length ? [ui.node('div', { className: 'weather-emoji', 'aria-hidden': 'true', text: todayEmoji }), ui.node('strong', { text: ui.temperature(weather[0].high, settings().temperatureUnit) }), ui.node('p', { text: weather[0].condition }), ui.node('p', { text: localWeather ? '📍 ' + localData.cityLabel : weather[0].label })] : [empty('🌤️ Weather will appear here.')];
    if (localWeather) weatherNow.push(localAttribution(true));
    root.appendChild(ui.node('section', { className: 'screen-heading' }, [ui.node('div', {}, clockNodes()), ui.node('div', { className: 'briefing' }, [ui.node('span', { className: 'eyebrow', text: '☀️ Our day' }), ui.node('h1', {}, [ui.node('span', { 'aria-hidden': 'true', text: '💛 ' }), ui.node('span', { text: data.briefing.title })]), ui.node('p', { text: data.briefing.text })]), ui.node('div', { className: 'weather-now' }, weatherNow)]));
    var week = (data.week || []).slice();
    weather.forEach(function (day) { if (week.length < 7 && !week.some(function (item) { return item.date === day.date; })) week.push({ date: day.date, events: [] }); });
    week.sort(function (left, right) { return left.date.localeCompare(right.date); });
    currentWeekByDate = {};
    var weekRows = week.map(function (day) {
      var forecast = weather.filter(function (item) { return item.date === day.date; })[0] || null;
      currentWeekByDate[day.date] = { date: day.date, events: day.events || [], forecast: forecast };
      var count = (day.events || []).length;
      var label = dayLabel(day.date) + (count ? ', ' + count + (count === 1 ? ' plan' : ' plans') : ', no plans') + ', tap to open';
      var button = ui.node('button', { className: 'week-day week-day-open', 'data-day-date': day.date, 'aria-label': label });
      button.appendChild(ui.node('strong', { text: (day.date === ui.dateParts(settings().timezone || 'UTC').date ? '🎉 ' : '') + dayLabel(day.date) }));
      (day.events || []).slice(0, 2).forEach(function (event) { button.appendChild(ui.node('p', { text: '⭐ ' + [event.time, event.title, event.person].filter(Boolean).join(' · ') })); });
      if (count > 2) button.appendChild(ui.node('p', { className: 'more-hint', text: '+' + (count - 2) + ' more 👆' }));
      if (!day.events.length && !forecast) button.appendChild(empty('🎈 Breathe.'));
      if (forecast) button.appendChild(ui.node('p', { className: 'weather-small' + (localWeather ? ' local-forecast' : ''), text: weatherEmoji(forecast.condition) + ' ' + ui.temperatureRange(forecast.low, forecast.high, settings().temperatureUnit) + ' · ' + forecast.condition }));
      button.addEventListener('click', function (event) { event.stopPropagation(); openDay(day.date); });
      return button;
    });
    function previewList(items, renderItem, emptyText, max) {
      if (!items.length) return [empty(emptyText)];
      var shown = items.slice(0, max || 3).map(renderItem);
      if (items.length > (max || 3)) shown.push(ui.node('p', { className: 'more-hint', text: '+' + (items.length - (max || 3)) + ' more — tap to see 👀' }));
      return shown;
    }
    var reminders = previewList(data.reminders || [], function (item) { return ui.node('p', { text: '🔔 ' + [item.time ? '🕘 ' + item.time : '', item.title, item.person ? '👪 ' + item.person : ''].filter(Boolean).join(' · ') }); }, '🎈 Nothing to remember just now.');
    var news = previewList(data.news || [], function (item) { return ui.node('div', { className: 'news-item' }, [ui.node('h3', { text: '🌍 ' + item.title }), ui.node('p', { text: item.summary })]); }, '🌍 Only the headlines you choose.', 2);
    var nearbySource = localNearby ? localData.nearby : data.nearby || [];
    var nearby = previewList(nearbySource, function (item) { return ui.node('p', { text: '📍 ' + [item.title, item.when].filter(Boolean).join(' · ') }); }, '📍 Local plans will appear here.');
    if (localNearby) nearby.push(localAttribution(false));
    var prompts = (data.prompts || []).length ? [ui.node('ul', {}, data.prompts.slice(0, 3).map(function (item) { return ui.node('li', { text: '💬 ' + item }); }))] : [empty('💬 A good conversation can start here.')];
    if ((data.prompts || []).length > 3) prompts.push(ui.node('p', { className: 'more-hint', text: '+' + ((data.prompts || []).length - 3) + ' more — tap to see 👀' }));
    var kids = personRows(data.kids || []).slice(0, 3);
    if ((data.kids || []).length > 3) kids.push(ui.node('p', { className: 'more-hint', text: '+' + ((data.kids || []).length - 3) + ' more — tap to see 👀' }));
    if (!kids.length) kids = [empty('🎈 Nothing to catch up on here.')];
    var parents = personRows(data.parents || []).slice(0, 3);
    if ((data.parents || []).length > 3) parents.push(ui.node('p', { className: 'more-hint', text: '+' + ((data.parents || []).length - 3) + ' more — tap to see 👀' }));
    if (!parents.length) parents = [empty('🎈 Nothing to catch up on here.')];
    var weekContent = weekRows.length ? [ui.node('div', { className: 'week-grid' }, weekRows)] : [empty('📅 Your assistant can add the week ahead.')];
    if (localWeather) weekContent.push(localAttribution(true));
    var grid = ui.node('div', { className: 'family-grid' }, [
      ui.node('div', { className: 'tile-row week-row', role: 'group', 'aria-label': 'This week' }, [tile('This week', weekContent, 'week-tile')]),
      ui.node('div', { className: 'tile-row people-row', role: 'group', 'aria-label': 'Family' }, [tile('For the kids', kids), tile('Little reminders', reminders), tile('For the grown-ups', parents), listsTile(data.lists)]),
      ui.node('div', { className: 'tile-row world-row', role: 'group', 'aria-label': 'Around us' }, [tile('A little of the world', news), tile('Around the table', prompts), tile('Around town', nearby)])
    ]);
    var scene = sceneNode();
    if (scene) root.appendChild(scene);
    root.appendChild(grid);
    if (!localWeather && data.weatherAttribution && (data.weather || []).length) root.appendChild(ui.node('p', { className: 'weather-attribution', text: data.weatherAttribution }));
    var toast = voiceToastNode();
    if (toast) root.appendChild(toast);
  }
  function isoForDay(year, monthZero, day) {
    return year + '-' + ('0' + (monthZero + 1)).slice(-2) + '-' + ('0' + day).slice(-2);
  }
  function calendar() {
    var zone = settings().timezone || 'UTC';
    var now = new Date();
    var year = Number(now.toLocaleDateString('en-US', { timeZone: zone, year: 'numeric' }));
    var month = Number(now.toLocaleDateString('en-US', { timeZone: zone, month: 'numeric' })) - 1;
    var today = Number(now.toLocaleDateString('en-US', { timeZone: zone, day: 'numeric' }));
    var start = new Date(Date.UTC(year, month, 1)).getUTCDay();
    var total = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    var monthName = now.toLocaleDateString('en-US', { timeZone: zone, month: 'long' });
    var cells = 'SMTWTFS'.split('').map(function (day) { return ui.node('span', { className: 'weekday', text: day }); });
    for (var padding = 0; padding < start; padding++) cells.push(ui.node('span', { className: 'cal-pad', text: '' }));
    for (var day = 1; day <= total; day++) {
      (function (number) {
        var iso = isoForDay(year, month, number);
        var entry = currentWeekByDate[iso];
        var count = entry && entry.events ? entry.events.length : 0;
        var isToday = number === today;
        var cell = ui.node('button', { className: 'cal-day' + (isToday ? ' today' : '') + (count ? ' has-plans' : ''), 'data-day-date': iso, 'aria-label': monthName + ' ' + number + (count ? ', ' + count + (count === 1 ? ' plan' : ' plans') + ', tap to open' : ', no plans, tap to open'), 'aria-current': isToday ? 'date' : 'false' });
        cell.appendChild(ui.node('span', { text: (isToday ? '🎉' : '') + String(number) }));
        if (count) cell.appendChild(ui.node('span', { className: 'cal-dot', 'aria-hidden': 'true', text: '●' }));
        cell.addEventListener('click', function (event) { event.stopPropagation(); openDay(iso); });
        cells.push(cell);
      }(day));
    }
    return ui.node('section', { className: 'month-calendar' }, [ui.node('h2', { text: '🗓️ ' + monthName }), ui.node('p', { className: 'muted cal-hint', text: 'Tap a day to see its plans 👆' }), ui.node('div', { className: 'calendar-grid' }, cells)]);
  }
  function nextItem() {
    if (!valid()) return null;
    var data = envelope.snapshot;
    var parts = ui.dateParts(settings().timezone || data.timezone || 'UTC');
    var today = parts.date;
    var current = parts.hour * 60 + parts.minute;
    var events = [];
    (data.week || []).forEach(function (day) {
      if (day.date < today) return;
      day.events.forEach(function (event) {
        var match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(event.time || '');
        var hour = match ? Number(match[1]) : -1;
        var minute = match && match[2] ? Number(match[2]) : 0;
        var period = match && match[3] ? match[3].toLowerCase() : null;
        var recognized = match && hour <= (period ? 12 : 23) && hour >= (period ? 1 : 0) && minute <= 59;
        if (recognized && period) hour = hour % 12 + (period === 'pm' ? 12 : 0);
        var time = recognized ? hour * 60 + minute : 1440;
        var allDay = /^(all day|today)$/i.test(event.time || '');
        if (day.date > today || recognized && time >= current || allDay) events.push({ title: event.title, label: recognized ? 'Up next' : 'On the calendar', detail: [day.date === today ? 'Today' : dayLabel(day.date), event.time, event.person].filter(Boolean).join(' · '), sort: day.date + String(time).padStart(4, '0') });
      });
    });
    events.sort(function (left, right) { return left.sort.localeCompare(right.sort); });
    if (events.length) return events[0];
    if (data.reminders && data.reminders.length) return { title: data.reminders[0].title, label: 'A little reminder', detail: [data.reminders[0].time, data.reminders[0].person].filter(Boolean).join(' · ') };
    return null;
  }
  function frameAvailable() {
    var ids = valid() && !night && settings().showPhotos !== false ? envelope.snapshot.photos || [] : [];
    return ids.filter(function (id) { return photos[id]; });
  }
  function frameDots(count) {
    var dots = ui.node('div', { className: 'frame-dots', 'aria-hidden': 'true' });
    for (var index = 0; index < count; index++) dots.appendChild(ui.node('span', { className: index === photoIndex % count ? 'is-current' : '' }));
    return dots;
  }
  function frameShell(available) {
    var total = available.length;
    var currentSrc = photos[available[photoIndex % total]];
    var stage = ui.node('div', { className: 'frame-stage' });
    stage.appendChild(ui.node('img', { className: 'frame-photo is-visible', src: currentSrc, alt: 'A photo chosen for your home' }));
    if (total > 1) {
      var preload = ui.node('img', { className: 'frame-photo', src: photos[available[(photoIndex + 1) % total]], alt: '' });
      preload.setAttribute('aria-hidden', 'true');
      stage.appendChild(preload);
    }
    var clockChip = ui.node('div', { className: 'frame-chip frame-clock' }, [ui.node('div', { className: 'frame-time', 'data-clock': '', 'aria-label': 'Time' }), ui.node('div', { className: 'frame-day', 'data-date': '' })]);
    var next = nextItem();
    var nextChip = ui.node('section', { className: 'frame-chip frame-next' }, [ui.node('p', { className: 'eyebrow', text: next ? '⭐ ' + next.label : '💛 A moment together' }), ui.node('h2', { text: next ? next.title : '🎈 A little room to breathe.' }), ui.node('p', { text: next ? next.detail : 'Tap Our day above for the full week 👆' })]);
    var calWrap = ui.node('div', { className: 'frame-calendar' }, [calendar()]);
    var overlay = ui.node('div', { className: 'frame-overlay' }, [clockChip, ui.node('div', { className: 'frame-row' }, [nextChip, calWrap])]);
    var shell = ui.node('section', { className: 'quiet-shell quiet-frame', 'aria-label': 'Family photo frame' }, [stage, ui.node('div', { className: 'frame-scrim', 'aria-hidden': 'true' }), overlay]);
    if (total > 1) shell.appendChild(frameDots(total));
    return shell;
  }
  function rotateFrame() {
    var stage = root.querySelector('.frame-stage');
    if (!stage) return false;
    var available = frameAvailable();
    if (available.length < 2) return false;
    var layers = stage.querySelectorAll('.frame-photo');
    if (layers.length < 2) return false;
    var shown = stage.querySelector('.frame-photo.is-visible') || layers[0];
    var hidden = shown === layers[0] ? layers[1] : layers[0];
    var src = photos[available[photoIndex % available.length]];
    if (!src) return false;
    function flip() {
      shown.classList.remove('is-visible');
      shown.setAttribute('aria-hidden', 'true');
      hidden.classList.add('is-visible');
      hidden.removeAttribute('aria-hidden');
      var dots = root.querySelector('.frame-dots');
      if (dots) Array.prototype.forEach.call(dots.children, function (dot, index) { dot.className = index === photoIndex % available.length ? 'is-current' : ''; });
    }
    if (hidden.getAttribute('src') === src) { flip(); return true; }
    hidden.onload = function () { hidden.onload = null; flip(); };
    hidden.onerror = function () { hidden.onload = null; };
    hidden.src = src;
    window.setTimeout(function () { if (hidden.getAttribute('src') === src && !hidden.classList.contains('is-visible')) flip(); }, 2500);
    return true;
  }
  function rebuildWeekIndex() {
    currentWeekByDate = {};
    if (!valid()) return;
    var data = envelope.snapshot;
    var weather = (localValid() && localData.weather.length ? localData.weather : data.weather || []);
    (data.week || []).forEach(function (day) {
      var forecast = weather.filter(function (item) { return item.date === day.date; })[0] || null;
      currentWeekByDate[day.date] = { date: day.date, events: day.events || [], forecast: forecast };
    });
    weather.forEach(function (day) { if (!currentWeekByDate[day.date]) currentWeekByDate[day.date] = { date: day.date, events: [], forecast: day }; });
  }
  function quietView() {
    rebuildWeekIndex();
    if (night) {
      var showDay = ui.button('Show full display', function () {
        quietHoursOverride = true; loadingFullDisplay = true; fullDisplayAfterPoll = pollNumber + 1;
        night = false; quiet = false; lastActivity = Date.now();
        render(true); poll();
      }, true);
      root.appendChild(ui.node('section', { className: 'quiet-shell night-ambient' }, [ui.node('div', { className: 'ambient-clock' }, [ui.node('div', { className: 'quiet-time', 'data-clock': '', 'aria-label': 'Time' }), ui.node('div', { className: 'quiet-date', 'data-date': '' }), ui.node('p', { className: 'night-explanation', text: 'Quiet hours hide weather and family information.' }), showDay]), calendar()])); return;
    }
    root.appendChild(heading('🌞', 'Our day'));
    voiceView = 'quiet';
    ensureVoiceDock();
    var next = nextItem();
    var nextContent = [ui.node('p', { className: 'eyebrow', text: next ? '⭐ ' + next.label : '💛 A moment together' }), ui.node('h2', { text: next ? '✨ ' + next.title : '🎈 A little room to breathe.' }), ui.node('p', { text: next ? next.detail : 'Tap a day on the calendar to explore 👆' })];
    if (localValid()) {
      var today = ui.dateParts(settings().timezone || 'UTC').date;
      var forecast = localData.weather.filter(function (day) { return day.date === today; })[0];
      var place = localData.nearby[0];
      var localChildren = [];
      if (forecast) localChildren.push(ui.node('p', { className: 'quiet-local-weather', text: forecast.label + ': ' + forecast.condition + ', ' + ui.temperatureRange(forecast.low, forecast.high, settings().temperatureUnit) }));
      if (place) localChildren.push(ui.node('p', { className: 'quiet-local-place', text: [place.title, place.when].filter(Boolean).join(' · ') }));
      if (localChildren.length) {
        localChildren.push(localAttribution(Boolean(forecast)));
        nextContent.push(ui.node('div', { className: 'quiet-local' }, localChildren));
      }
    }
    var framed = frameAvailable();
    var scene = sceneNode();
    if (framed.length) {
      if (scene) root.appendChild(scene);
      root.appendChild(frameShell(framed));
      var frameToast = voiceToastNode();
      if (frameToast) root.appendChild(frameToast);
      return;
    }
    var content = ui.node('div', { className: 'quiet-content' }, [ui.node('section', { className: 'quiet-next' }, nextContent), calendar()]);
    var shellChildren = [ui.node('div', { className: 'quiet-time', 'data-clock': '' }), ui.node('div', { className: 'quiet-date', 'data-date': '' })];
    if (scene) shellChildren.push(scene);
    shellChildren.push(content);
    var shell = ui.node('section', { className: 'quiet-shell' }, shellChildren);
    root.appendChild(shell);
    var quietToast = voiceToastNode();
    if (quietToast) root.appendChild(quietToast);
  }
  function tickClock() {
    var parts = ui.dateParts(settings().timezone || valid() && envelope.snapshot.timezone || 'UTC');
    Array.prototype.forEach.call(root.querySelectorAll('[data-clock]'), function (element) { element.textContent = parts.clock; });
    Array.prototype.forEach.call(root.querySelectorAll('[data-date]'), function (element) { element.textContent = parts.day; });
  }
  function ack() {
    if (!ackPending || document.hidden || !valid()) return;
    var receipt = ackPending;
    requestAnimationFrame(function () { requestAnimationFrame(function () {
      if (document.hidden || !valid() || ackPending !== receipt) return;
      device('/device/v1/ack', receipt).then(function () { if (ackPending === receipt) ackPending = null; }).catch(function () {});
    }); });
  }
  function voiceAckLabel(state) {
    if (state === 'heard') return 'Heard you';
    if (state === 'acted') return 'Done';
    if (state === 'failed') return 'That did not work';
    return 'Got it';
  }
  function syncVoiceAgents(value) {
    var next = [];
    var listed = value && value.agents;
    if (Array.isArray(listed)) {
      listed.slice(0, 6).forEach(function (entry) {
        if (!entry || typeof entry !== 'object') return;
        var name = typeof entry.name === 'string' ? entry.name.trim().slice(0, 40) : '';
        if (!name) return;
        next.push({ id: typeof entry.id === 'string' && entry.id ? entry.id.slice(0, 64) : name, name: name });
      });
    }
    if (!next.length) {
      var fallback = (value && value.settings && value.settings.defaultVoiceAgent) || (value && value.homeName) || 'Helper';
      if (typeof fallback !== 'string' || !fallback.trim()) fallback = 'Helper';
      next.push({ id: 'helper', name: fallback.trim().slice(0, 40) });
    }
    voiceAgents = next;
  }
  function selectedVoiceAgent() {
    var stored = null;
    var wanted = settings().defaultVoiceAgent || null;
    try { stored = sessionStorage.getItem(VOICE_AGENT_KEY); } catch (_) {}
    if (stored) wanted = stored;
    if (wanted) {
      for (var index = 0; index < voiceAgents.length; index++) {
        if (voiceAgents[index].id === wanted || voiceAgents[index].name === wanted) return voiceAgents[index].id;
      }
    }
    return voiceAgents.length ? voiceAgents[0].id : null;
  }
  function paintVoiceAgents() {
    if (!voiceAgentsBox) return;
    if (!voiceAgents.length) syncVoiceAgents(envelope);
    ui.clear(voiceAgentsBox);
    var selected = selectedVoiceAgent();
    voiceAgents.forEach(function (agent) {
      var pill = ui.node('button', { type: 'button', className: 'voice-agent' + (agent.id === selected ? ' is-selected' : ''), text: agent.name });
      pill.setAttribute('aria-pressed', agent.id === selected ? 'true' : 'false');
      pill.addEventListener('click', function () {
        try { sessionStorage.setItem(VOICE_AGENT_KEY, agent.id); } catch (_) {}
        paintVoiceAgents();
      });
      voiceAgentsBox.appendChild(pill);
    });
  }
  function refreshVoiceBeam() {
    if (!voiceBeam) return;
    if (voiceBeam.setProcessing) voiceBeam.setProcessing(voiceState === 'processing' || voicePending !== null);
    if (voiceBeam.setLevel && voiceState !== 'listening') voiceBeam.setLevel(0);
  }
  function listeningClock() {
    var seconds = Math.max(0, Math.floor((Date.now() - voiceStartedAt) / 1000));
    return Math.floor(seconds / 60) + ':' + ('0' + (seconds % 60)).slice(-2);
  }
  function refreshVoiceStatus() {
    if (!voiceStatusLine) return;
    if (voiceState === 'listening') voiceStatusLine.textContent = 'Release to send \u00b7 ' + listeningClock();
    else voiceStatusLine.textContent = voiceStateText;
  }
  function setVoiceState(state, text) {
    voiceState = state;
    voiceStateText = text || { idle: 'Hold to talk', listening: 'Release to send', sending: 'Sending...', processing: 'Working on it...', done: 'Got it', error: 'That did not send. Try again.' }[state] || 'Hold to talk';
    if (voiceTalk) {
      voiceTalk.textContent = voiceStateText;
      voiceTalk.setAttribute('aria-label', voiceStateText);
      voiceTalk.disabled = state === 'sending' || state === 'processing' || state === 'done' || state === 'error';
    }
    refreshVoiceStatus();
    refreshVoiceBeam();
    clearTimeout(voiceReset);
    if (state === 'done') voiceReset = window.setTimeout(function () { if (voiceState === 'done') setVoiceState('idle'); }, 1500);
    if (state === 'error') voiceReset = window.setTimeout(function () { if (voiceState === 'error') setVoiceState('idle'); }, 3000);
    if (state !== 'listening') clearInterval(voiceTick);
  }
  function startVoiceMeter() {
    if (!voiceBeam) return;
    function frame() {
      if (voiceState !== 'listening') { refreshVoiceBeam(); return; }
      var level = 0;
      if (voiceAnalyser && voiceFreq) {
        try {
          voiceAnalyser.getByteFrequencyData(voiceFreq);
          var bins = Math.min(16, voiceFreq.length);
          var total = 0;
          for (var index = 0; index < bins; index++) total += voiceFreq[index];
          level = bins ? total / bins / 255 : 0;
        } catch (_) { level = 0; }
      }
      if (voiceBeam && voiceBeam.setLevel) voiceBeam.setLevel(level);
      voiceMeterFrame = window.requestAnimationFrame(frame);
    }
    if (voiceMeterFrame) window.cancelAnimationFrame(voiceMeterFrame);
    voiceMeterFrame = window.requestAnimationFrame(frame);
  }
  function stopVoiceMeter() {
    if (voiceMeterFrame) { window.cancelAnimationFrame(voiceMeterFrame); voiceMeterFrame = 0; }
    if (voiceBeam && voiceBeam.setLevel) voiceBeam.setLevel(0);
  }
  function startVoiceTick() {
    clearInterval(voiceTick);
    voiceTick = window.setInterval(function () {
      if (voiceState !== 'listening') return;
      if (Date.now() - voiceStartedAt >= 120000) { stopCapture(); return; }
      refreshVoiceStatus();
    }, 250);
  }
  function stopStream(stream) {
    if (!stream || !stream.getTracks) return;
    try {
      stream.getTracks().forEach(function (track) { try { if (track.stop) track.stop(); } catch (_) {} });
    } catch (_) {}
  }
  function teardownCapture() {
    stopVoiceMeter();
    stopStream(voiceStream);
    voiceStream = null;
    if (voiceAudio) { try { voiceAudio.close(); } catch (_) {} }
    voiceAudio = null;
    voiceAnalyser = null;
    voiceFreq = null;
    if (voiceRecorder) {
      try { voiceRecorder.onstop = null; voiceRecorder.ondataavailable = null; voiceRecorder.onerror = null; voiceRecorder.stop(); } catch (_) {}
    }
    voiceRecorder = null;
    clearInterval(voiceTick);
  }
  function captureFailed() {
    captureGeneration++;
    teardownCapture();
    setVoiceState('error', 'Microphone is not available on this screen.');
  }
  function sendFailed() {
    captureGeneration++;
    teardownCapture();
    setVoiceState('error', 'That did not send. Try again.');
  }
  function pickRecorderMime() {
    if (!window.MediaRecorder || !window.MediaRecorder.isTypeSupported) return '';
    var chain = ['audio/webm;codecs=opus', 'audio/webm'];
    for (var index = 0; index < chain.length; index++) {
      try { if (window.MediaRecorder.isTypeSupported(chain[index])) return chain[index]; } catch (_) {}
    }
    return '';
  }
  function connectMeter(stream) {
    if (!voiceAudio || !stream) return;
    try {
      var source = voiceAudio.createMediaStreamSource(stream);
      var analyser = voiceAudio.createAnalyser();
      analyser.smoothingTimeConstant = 0.65;
      analyser.fftSize = 256;
      voiceAnalyser = analyser;
      voiceFreq = new Uint8Array(analyser.frequencyBinCount);
      source.connect(analyser);
    } catch (_) { voiceAnalyser = null; voiceFreq = null; }
  }
  function startCapture() {
    if (voiceState !== 'idle') return;
    voiceStartedAt = Date.now();
    voiceDurationMs = 0;
    voiceChunks = [];
    captureGeneration++;
    var generation = captureGeneration;
    setVoiceState('listening');
    startVoiceTick();
    startVoiceMeter();
    try {
      var AudioCtor = window.AudioContext || window.webkitAudioContext;
      if (AudioCtor) {
        voiceAudio = new AudioCtor();
        if (voiceAudio && voiceAudio.state === 'suspended' && voiceAudio.resume) {
          var resumed = voiceAudio.resume();
          if (resumed && resumed.catch) resumed.catch(function () {});
        }
      }
    } catch (_) { voiceAudio = null; }
    var media = null;
    try {
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) media = navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (_) { media = null; }
    if (!media || typeof media.then !== 'function') { captureFailed(); return; }
    media.then(function (stream) {
      if (generation !== captureGeneration || voiceState !== 'listening') { stopStream(stream); return; }
      voiceStream = stream;
      connectMeter(stream);
      var mime = pickRecorderMime();
      var recorder = null;
      try {
        if (window.MediaRecorder) recorder = mime ? new window.MediaRecorder(stream, { mimeType: mime }) : new window.MediaRecorder(stream);
      } catch (_) { recorder = null; }
      if (!recorder) { captureFailed(); return; }
      voiceRecorder = recorder;
      voiceMime = recorder.mimeType || mime || 'audio/webm';
      recorder.ondataavailable = function (event) {
        if (event && event.data && event.data.size) voiceChunks.push(event.data);
      };
      recorder.onerror = function () { if (voiceState === 'listening' || voiceState === 'sending') sendFailed(); };
      recorder.onstop = function () { finishRecording(); };
      try { recorder.start(); } catch (_) { captureFailed(); }
    }).catch(function () {
      if (generation === captureGeneration && voiceState === 'listening') captureFailed();
    });
  }
  function stopCapture() {
    if (voiceState !== 'listening') return;
    clearInterval(voiceTick);
    voiceDurationMs = Math.max(0, Date.now() - voiceStartedAt);
    if (voiceDurationMs < 600) {
      captureGeneration++;
      teardownCapture();
      setVoiceState('error', 'Too short');
      return;
    }
    setVoiceState('sending');
    if (voiceRecorder) {
      try { voiceRecorder.stop(); return; } catch (_) {}
      finishRecording();
      return;
    }
    sendFailed();
  }
  function bytesToBase64(bytes, start, end) {
    var binary = '';
    var piece = 8192;
    for (var offset = start; offset < end; offset += piece) {
      binary += String.fromCharCode.apply(null, bytes.subarray(offset, Math.min(offset + piece, end)));
    }
    return btoa(binary);
  }
  function blobToArray(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject({ status: 0 }); };
      try { reader.readAsArrayBuffer(blob); } catch (_) { reject({ status: 0 }); }
    });
  }
  function cancelUpload(uploadId) {
    return device('/device/v1/voice', { action: 'cancel', uploadId: uploadId }).then(function () {}, function () {});
  }
  function uploadVoice(blob, durationMs) {
    return blobToArray(blob).then(function (buffer) {
      var bytes = new Uint8Array(buffer);
      if (!bytes.length) throw { status: 0 };
      return device('/device/v1/voice', { action: 'begin', mime: 'audio/webm', byteLength: bytes.length, durationMs: durationMs }).then(function (started) {
        var uploadId = started && started.uploadId;
        if (!uploadId) throw { status: 0 };
        var sequence = 0;
        function sendParts(offset) {
          if (offset >= bytes.length) return Promise.resolve();
          var end = Math.min(offset + 4096, bytes.length);
          return device('/device/v1/voice', { action: 'part', uploadId: uploadId, seq: sequence, data: bytesToBase64(bytes, offset, end) }).then(function () {
            sequence++;
            return sendParts(end);
          });
        }
        return sendParts(0).then(function () {
          setVoiceState('processing');
          return device('/device/v1/voice', { action: 'end', uploadId: uploadId });
        }).catch(function (error) {
          return cancelUpload(uploadId).then(function () { throw error; });
        });
      });
    });
  }
  function finishRecording() {
    var durationMs = voiceDurationMs;
    var blob = null;
    try { blob = new Blob(voiceChunks, { type: voiceMime }); } catch (_) { blob = null; }
    voiceChunks = [];
    captureGeneration++;
    teardownCapture();
    if (!blob || !blob.size) { setVoiceState('error', 'That did not send. Try again.'); return; }
    uploadVoice(blob, durationMs).then(function (result) {
      if (result && result.voiceAck) showVoiceToast(result.voiceAck, false);
      if (result && typeof result.messageId === 'string' && result.messageId) {
        voicePending = result.messageId;
        voicePendingAt = Date.now();
        voiceFastUntil = Date.now() + VOICE_FAST_WINDOW;
        schedulePoll();
      }
      setVoiceState('done');
      if (envelope) render(true);
    }).catch(function () {
      setVoiceState('error', 'That did not send. Try again.');
    });
  }
  function showVoiceToast(ack, pinned) {
    if (!ack || typeof ack !== 'object') return;
    var state = typeof ack.state === 'string' ? ack.state : '';
    if (pinned && ['heard', 'acted', 'failed'].indexOf(state) < 0) return;
    voiceToast = {
      id: typeof ack.id === 'string' ? ack.id : '',
      state: state,
      heard: typeof ack.heard === 'string' ? ack.heard.slice(0, 240) : '',
      agentName: typeof ack.agentName === 'string' ? ack.agentName.slice(0, 40) : ''
    };
    voiceToastAt = Date.now();
    voiceToastPinned = pinned === true;
  }
  function voiceToastNode() {
    if (night || !voiceToast) return null;
    if (!voiceToastPinned && Date.now() - voiceToastAt > 8000) return null;
    var toast = ui.node('div', { className: 'voice-toast', role: 'status', 'aria-live': 'polite' });
    if (voiceToast.agentName) toast.appendChild(ui.node('span', { className: 'voice-toast-agent', text: voiceToast.agentName }));
    toast.appendChild(ui.node('span', { className: 'voice-toast-heard', text: voiceToast.heard || voiceAckLabel(voiceToast.state) }));
    return toast;
  }
  function sceneBlockNode(block) {
    if (!block || typeof block !== 'object') return null;
    if (block.type === 'text') return ui.node('p', { className: 'scene-text', text: block.text });
    if (block.type === 'rows') {
      return ui.node('div', { className: 'scene-rows' }, (block.rows || []).map(function (row) {
        var tone = row.tone === 'good' ? 'good' : row.tone === 'warn' ? 'warn' : 'plain';
        return ui.node('div', { className: 'scene-row tone-' + tone }, [
          ui.node('span', { className: 'scene-row-label', text: row.label }),
          ui.node('span', { className: 'scene-row-value', text: row.value })
        ]);
      }));
    }
    if (block.type === 'chips') {
      return ui.node('div', { className: 'scene-chips' }, (block.chips || []).map(function (chip) { return ui.node('span', { className: 'scene-chip', text: chip }); }));
    }
    if (block.type === 'steps') {
      return ui.node('ol', { className: 'scene-steps' }, (block.steps || []).map(function (step) { return ui.node('li', { text: step }); }));
    }
    if (block.type === 'bars') {
      return ui.node('div', { className: 'scene-bars' }, (block.bars || []).map(function (bar) {
        var fill = ui.node('span', { className: 'scene-bar-fill' });
        fill.style.width = bar.value * 100 + '%';
        return ui.node('div', { className: 'scene-bar' }, [ui.node('span', { className: 'scene-bar-label', text: bar.label }), ui.node('span', { className: 'scene-bar-track' }, [fill])]);
      }));
    }
    return null;
  }
  function sceneNode() {
    var data = valid() ? envelope.snapshot : null;
    if (!data || night || !data.displayScene) return null;
    var scene = data.displayScene;
    if (!scene.id || dismissedSceneIds[scene.id]) return null;
    var ttl = Number(scene.ttlSeconds);
    if (!isFinite(ttl) || !(timestamp(data.generatedAt) + ttl * 1000 > Date.now())) return null;
    var dismiss = ui.button('Dismiss', function () {
      dismissedSceneIds[scene.id] = true;
      render(true);
    }, true);
    dismiss.className += ' scene-dismiss';
    var titles = ui.node('div', { className: 'scene-titles' }, [ui.node('h2', { text: scene.title })]);
    if (scene.subtitle) titles.appendChild(ui.node('p', { className: 'scene-subtitle', text: scene.subtitle }));
    var head = ui.node('div', { className: 'scene-head' }, [ui.node('span', { className: 'scene-icon', 'aria-hidden': 'true', text: SCENE_KIND_ICONS[scene.kind] || '✨' }), titles, dismiss]);
    var body = ui.node('div', { className: 'scene-body' });
    (Array.isArray(scene.blocks) ? scene.blocks : []).forEach(function (block) {
      var node = sceneBlockNode(block);
      if (node) body.appendChild(node);
    });
    return ui.node('section', { className: 'scene-card scene-kind-' + scene.kind }, [head, body]);
  }
  function syncVoicePresentation(value) {
    syncVoiceAgents(value);
    var changed = false;
    var ack = value && value.snapshot ? value.snapshot.voiceAck : null;
    if (ack && typeof ack === 'object') {
      if (['heard', 'acted', 'failed'].indexOf(ack.state) >= 0) {
        if (!voiceToast || voiceToast.id !== ack.id || voiceToast.state !== ack.state) {
          showVoiceToast(ack, true);
          changed = true;
        }
      }
      if (voicePending !== null && ack.id === voicePending && (ack.state === 'acted' || ack.state === 'failed')) {
        voicePending = null;
        refreshVoiceBeam();
      }
    } else if (voiceToastPinned) {
      voiceToast = null;
      voiceToastPinned = false;
      changed = true;
    }
    return changed;
  }
  function updateVoiceDock() {
    if (!voiceDock) return;
    if (voiceView !== null && !night && !voiceSheetOpen) voiceDock.removeAttribute('hidden');
    else voiceDock.setAttribute('hidden', 'hidden');
    document.body.classList.toggle('has-voice-dock', !voiceDock.hasAttribute('hidden'));
  }
  function ensureVoiceDock() {
    if (!voiceDock) {
      var talk = ui.node('button', { type: 'button', className: 'voice-talk', text: 'Hold to talk' });
      talk.setAttribute('aria-label', 'Hold to talk');
      voiceTalk = talk;
      voiceAgentsBox = ui.node('div', { className: 'voice-agents', role: 'group', 'aria-label': 'Assistants' });
      voiceStatusLine = ui.node('p', { className: 'voice-status', role: 'status', 'aria-live': 'polite', text: 'Hold to talk' });
      var bar = ui.node('div', { className: 'voice-bar' }, [voiceAgentsBox, talk, voiceStatusLine]);
      var dock = ui.node('div', { className: 'voice-dock', hidden: 'hidden' }, [bar]);
      if (typeof window.DisplayOSVoiceBeam === 'function') {
        try {
          voiceBeam = window.DisplayOSVoiceBeam(bar, { type: 'pill', colorVariant: 'mono', theme: 'dark', colors: SAGE_BEAM, bandColors: SAGE_BAND });
        } catch (_) { voiceBeam = null; }
      }
      talk.addEventListener('pointerdown', function () { startCapture(); });
      talk.addEventListener('pointerup', function () { stopCapture(); });
      talk.addEventListener('pointercancel', function () { stopCapture(); });
      talk.addEventListener('pointerleave', function () { stopCapture(); });
      talk.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
          event.preventDefault();
          if (!event.repeat) startCapture();
        }
      });
      talk.addEventListener('keyup', function (event) {
        if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
          event.preventDefault();
          stopCapture();
        }
      });
      talk.addEventListener('click', function (event) { event.preventDefault(); });
      document.body.appendChild(dock);
      voiceDock = dock;
    }
    paintVoiceAgents();
    updateVoiceDock();
  }
  function render(skipAck) {
    if (closeSheet) closeSheet();
    ui.clear(root);
    root.className = 'screen-shell';
    voiceView = null;
    updateVoiceDock();
    if (loadingFullDisplay) { panel('Loading your day.', 'Getting a fresh update for this screen.', [ui.button('Back to quiet hours', restoreQuietHours, true)]); return; }
    document.body.classList.toggle('night', night);
    if (!valid()) { if (localValid() && !quiet && !night) ourDay(); else quietView(); status.textContent = night ? '' : localNotice || (localEnabled.weather || localEnabled.nearby ? 'Your local information appears while this screen is connected.' : 'Waiting for a fresh family update.'); }
    else if (quiet || night) quietView();
    else ourDay();
    tickClock(); offerFullCards(); updateVoiceDock(); if (!skipAck) ack();
  }
  function loadPhotos() {
    var ids = valid() && settings().showPhotos !== false ? envelope.snapshot.photos || [] : [];
    Object.keys(photos).forEach(function (id) { if (ids.indexOf(id) < 0) { URL.revokeObjectURL(photos[id]); delete photos[id]; } });
    ids.forEach(function (id) {
      if (photos[id]) return;
      var active = envelope;
      device('/device/v1/media/' + encodeURIComponent(id), undefined, true).then(function (blob) {
        if (active !== envelope || !valid() || ['image/jpeg', 'image/png'].indexOf(blob.type) < 0 || blob.size > 98304) return;
        if (photos[id]) URL.revokeObjectURL(photos[id]);
        photos[id] = URL.createObjectURL(blob);
        if (quiet && !night) {
          if (root.querySelector('.quiet-frame')) {
            var known = frameAvailable();
            if (known.length === 1) render();
          } else render();
        }
      }).catch(function () {});
    });
  }
  var identityNode = null;
  function showIdentity() {
    if (!screenInfo.identifier) { if (identityNode && identityNode.parentNode) identityNode.parentNode.removeChild(identityNode); identityNode = null; return; }
    if (!identityNode) { identityNode = ui.node('p', { className: 'screen-identity' }); document.body.appendChild(identityNode); }
    identityNode.textContent = 'Screen ' + screenInfo.identifier;
  }
  function accept(value) {
    if (value.state && value.state !== 'owned') { quietHoursOverride = false; loadingFullDisplay = false; }
    if ((value.state === 'owned' || !value.state) && typeof value.screenIdentifier === 'string' && /^[A-Z0-9_-]{6}$/.test(value.screenIdentifier)) {
      screenInfo.identifier = value.screenIdentifier;
      screenInfo.screenName = value.screenName || screenInfo.screenName;
      screenInfo.homeName = value.homeName || screenInfo.homeName;
      screenInfo.allowEdits = value.allowListEdits === true;
      showIdentity();
    } else if (typeof value.screenName === 'string') {
      screenInfo.screenName = value.screenName;
      if (typeof value.homeName === 'string') screenInfo.homeName = value.homeName;
    }
    if (value.state === 'erase') {
      wipe(); pairing = null; screenInfo.identifier = ''; showIdentity();
      try { sessionStorage.removeItem('displayos-demo-device-token'); } catch (_) {}
      panel('Making a fresh start.', 'Your family information has been cleared.');
      device('/device/v1/erase', {}).then(function (erased) {
        if (token && erased.deviceToken) { token = erased.deviceToken; try { sessionStorage.setItem('displayos-demo-device-token', token); } catch (_) {} }
        getPairing();
      }).catch(function (error) { status.textContent = ui.message(error); });
      return;
    }
    if (value.state === 'unclaimed') {
      if (envelope) wipe();
      if (value.pairing) pairing = value.pairing;
      if (!pairing || timestamp(pairing.expiresAt) <= Date.now()) getPairing(); else showPairing();
      return;
    }
    if (value.state === 'confirm') {
      if (envelope) wipe();
      pairing = null;
      panel('Is this your home?', 'Check that these words match the ones on your phone.', [ui.node('p', { className: 'phrase', text: value.phrase }), ui.node('p', { text: value.homeName }), ui.button('Yes, this is my home', function (event) {
        event.currentTarget.disabled = true;
        device('/device/v1/confirm', { phrase: value.phrase }).then(function () { poll(); }).catch(function (error) { status.textContent = ui.message(error); event.currentTarget.disabled = false; });
      })]);
      return;
    }
    pairing = null;
    var key = JSON.stringify([value.revision, value.settings, value.homeName, value.screenName, value.screenIdentifier, value.allowListEdits === true, value.snapshot && value.snapshot.expiresAt]);
    if (!isNight(value.settings || settings())) quietHoursOverride = false;
    night = isNight(value.settings || settings()) && !quietHoursOverride;
    if (night) { wipe(); envelope = { settings: value.settings, homeName: 'DisplayOS' }; render(); status.textContent = ''; return; }
    var localChanged = syncLocal(value);
    var previousSnapshot = envelope && envelope.snapshot;
    envelope = value;
    status.textContent = value.snapshot ? '' : 'Your screen is ready. Your assistant can add your day.';
    if (!valid()) {
      if (key !== lastRender || localChanged || previousSnapshot) {
        wipe(true); envelope = { settings: value.settings, homeName: value.homeName, screenName: value.screenName, screenIdentifier: value.screenIdentifier }; lastRender = key; render();
      }
      fetchLocal(); return;
    }
    var voiceChanged = syncVoicePresentation(value);
    if (key !== lastRender) { lastRender = key; ackPending = { revision: value.revision, nonce: value.nonce }; render(); loadPhotos(); }
    else { if (localChanged || voiceChanged) render(true); if (ackPending) ack(); }
    fetchLocal();
  }
  var pollInFlight = false;
  function restoreQuietHours() {
    var current = settings();
    quietHoursOverride = false; loadingFullDisplay = false; night = isNight(current); quiet = false;
    wipe(); envelope = { settings: current, homeName: 'DisplayOS' };
    render(true); poll();
  }
  function schedulePoll() {
    clearTimeout(pollTimer);
    var base = displayState === 'owned' ? 30000 : 5000;
    if (document.hidden && displayState === 'owned') base = 60000;
    if (voicePending !== null || Date.now() < voiceFastUntil) base = 1500;
    var delay = Math.min(300000, base * Math.pow(2, Math.min(failedPolls, 5)));
    pollTimer = setTimeout(poll, delay + Math.floor(Math.random() * Math.min(3000, delay / 10)));
  }
  function recover() {
    if (!demoKey || !demoKey.privateKey || !window.crypto || !crypto.subtle || Date.now() - recoveryAt < 60000) return Promise.reject({ status: 401 });
    recoveryAt = Date.now();
    return device('/device/v1/recover/start', { deviceId: demoKey.deviceId, publicKey: demoKey.publicKey }).then(function (challenge) {
      return crypto.subtle.importKey('jwk', demoKey.privateKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']).then(function (key) { return crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(challenge.message)); }).then(function (signature) {
        var bytes = new Uint8Array(signature); var encoded = ''; for (var index = 0; index < bytes.length; index++) encoded += String.fromCharCode(bytes[index]);
        return device('/device/v1/recover/verify', { deviceId: demoKey.deviceId, challenge: challenge.challenge, signature: btoa(encoded).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') });
      });
    }).then(function (value) { token = value.deviceToken; sessionStorage.setItem('displayos-demo-device-token', token); });
  }
  function poll() {
    if (pollInFlight) return;
    clearTimeout(pollTimer);
    pollInFlight = true;
    var number = ++pollNumber;
    var superseded = false;
    device('/device/v1/poll').then(function (value) {
      failedPolls = 0;
      if (loadingFullDisplay && number < fullDisplayAfterPoll) { superseded = true; return; }
      loadingFullDisplay = false; displayState = value.state || 'owned'; accept(value);
    }).catch(function (error) {
      failedPolls++;
      var hadLocal = localData !== null;
      clearLocal(); localPollReady = false;
      if (hadLocal && envelope) render(true);
      status.textContent = error.status === 0 ? 'Connection paused. We will try again.' : ui.message(error);
      if (error.status === 401 || error.status === 403) { wipe(); pairing = null; panel('Your screen needs a hand.', 'Ask the person who prepared this screen to reconnect it. Your family information is not showing.'); if (error.status === 401 && demoKey) recover().then(function () { setTimeout(poll, 50); }).catch(function () {}); }
      else if (!envelope && !pairing) panel('We are waiting for a connection.', 'Check your Wi-Fi. This screen will try again on its own.');
    }).finally(function () { pollInFlight = false; if (superseded) { clearTimeout(pollTimer); pollTimer = setTimeout(poll, 0); } else schedulePoll(); });
  }
  function activity(event) {
    lastActivity = Date.now();
    var target = event.target;
    var onInteractive = target && target.closest && target.closest('button, .family-tile, .screen-sheet');
    if (quiet && !onInteractive) { quiet = false; render(); }
    if (displayState === 'owned') poll();
  }
  document.addEventListener('pointerdown', activity);
  document.addEventListener('keydown', activity);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && voiceState === 'listening') stopCapture();
    if (!document.hidden) { tickClock(); ack(); poll(); } else { localGeneration++; localInFlight = null; }
  });
  window.addEventListener('online', poll);
  window.addEventListener('offline', function () { var hadLocal = localData !== null; clearLocal(); localPollReady = false; if (hadLocal && envelope) render(true); });
  window.addEventListener('resize', offerFullCards);
  setInterval(function () {
    if (envelope && envelope.snapshot && !valid()) { var currentSettings = envelope.settings; var name = envelope.homeName; var screenName = envelope.screenName; var screenIdentifier = envelope.screenIdentifier; wipe(true); envelope = { settings: currentSettings, homeName: name, screenName: screenName, screenIdentifier: screenIdentifier }; quiet = true; render(); }
    if (localData && localData.expiresAt <= Date.now()) { clearLocal(); if (envelope) render(true); }
    if (pairing && timestamp(pairing.expiresAt) <= Date.now()) { pairing = null; showPairing(); getPairing(); }
    tickPairing();
    if (voicePending !== null && Date.now() - voicePendingAt >= VOICE_FAST_WINDOW) { voicePending = null; refreshVoiceBeam(); }
    if (voiceToast && !voiceToastPinned && Date.now() - voiceToastAt > 8000) { voiceToast = null; if (envelope && !closeSheet) render(true); }
    if (!envelope) return;
    var current = settings();
    if (!isNight(current)) quietHoursOverride = false;
    var nightNow = isNight(current) && !quietHoursOverride;
    var needsRender = false;
    if (night !== nightNow) { night = nightNow; if (night) { wipe(); envelope = { settings: current, homeName: 'DisplayOS' }; } else { poll(); } needsRender = true; }
    if (!quiet && Date.now() - lastActivity > (current.quietAfterSeconds || 120) * 1000) { quiet = true; needsRender = true; }
    if (quiet && !night && Date.now() - photoTick > 30000) {
      photoTick = Date.now(); photoIndex++;
      if (root.querySelector('.quiet-frame')) { if (!rotateFrame()) needsRender = true; }
      else needsRender = true;
    }
    if (needsRender) render(); else tickClock();
    fetchLocal();
  }, 1000);
  poll();
}());
