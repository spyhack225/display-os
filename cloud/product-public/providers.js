(function () {
  'use strict';
  var ATTRIBUTION = 'Google Maps';

  function localExpiry(value, now) {
    if (!Number.isSafeInteger(value.fetchedAt) || !Number.isSafeInteger(value.expiresAt) || value.fetchedAt > now + 30000 || value.expiresAt <= now || value.expiresAt <= value.fetchedAt || value.expiresAt - value.fetchedAt > 3600000) throw { status: 400 };
    return Math.min(value.expiresAt, now + 3600000);
  }

  function update(current, preview, timezone, now) {
    var snapshot = current.snapshot ? JSON.parse(JSON.stringify(current.snapshot)) : { schemaVersion: 1, timezone: timezone, briefing: { title: 'Your day, together', text: 'Only the plans and reminders you choose belong here.' }, weather: [], week: [], reminders: [], kids: [], parents: [], news: [], prompts: [], nearby: [], photos: [] };
    if (current.snapshot && (!Number.isSafeInteger(current.snapshot.expiresAt) || current.snapshot.expiresAt <= now)) throw { status: 409 };
    snapshot.generatedAt = now;
    snapshot.expiresAt = current.snapshot ? Math.min(current.snapshot.expiresAt, now + 3600000) : now + 3600000;
    if (preview.kind === 'calendar') snapshot.week = JSON.parse(JSON.stringify(preview.value.week));
    else if (preview.kind === 'inbox') snapshot.reminders = JSON.parse(JSON.stringify(preview.value.reminders));
    else throw { status: 400 };
    return snapshot;
  }

  function bounded(value, kind) {
    var rows = value && value[kind === 'calendar' ? 'week' : kind === 'inbox' ? 'reminders' : 'weather'];
    if (!Array.isArray(rows) || rows.length > (kind === 'inbox' ? 4 : 7)) throw { status: 400 };
    rows.forEach(function (row) {
      if (!row || typeof row !== 'object') throw { status: 400 };
      if (kind === 'calendar') {
        if (typeof row.date !== 'string' || !Array.isArray(row.events) || row.events.length > 2) throw { status: 400 };
        row.events.forEach(function (event) { if (!event || typeof event.title !== 'string' || typeof event.time !== 'string' || typeof event.person !== 'string' || event.title.length > 80 || event.time.length > 80 || event.person.length > 80) throw { status: 400 }; });
      } else if (kind === 'inbox') {
        if (typeof row.title !== 'string' || typeof row.time !== 'string' || typeof row.person !== 'string' || row.title.length > 80 || row.time.length > 80 || row.person.length > 80) throw { status: 400 };
      } else if (typeof row.date !== 'string' || typeof row.label !== 'string' || typeof row.condition !== 'string' || !Number.isFinite(row.high) || !Number.isFinite(row.low) || row.label.length > 80 || row.condition.length > 80) throw { status: 400 };
    });
    return value;
  }

  function mount(context) {
    var ui = context.ui;
    var home = context.home;
    if (!home || home.role !== 'owner' || !context.principal) return null;
    var panel = ui.node('details', { className: 'sources-panel' });
    panel.appendChild(ui.node('summary', { text: 'Things to bring home' }));
    var body = ui.node('div', { className: 'sources-body' });
    panel.appendChild(body);
    var status = null;
    var preview = null;
    var selectedScreen = home.screens && home.screens.length ? home.screens[0].id : '';
    var savedLocation = null;
    var localPreview = null;
    var localTimer = null;
    var localGeneration = 0;
    var timezone = home.settings && home.settings.timezone || 'UTC';

    function note(text) { return ui.node('p', { text: text }); }
    function buttons(children) { return ui.node('div', { className: 'actions' }, children); }
    function check(label, checked, disabled) {
      var input = ui.node('input', { type: 'checkbox', checked: Boolean(checked), disabled: Boolean(disabled) });
      return { input: input, element: ui.node('label', { className: 'checkbox' }, [input, ui.node('span', { text: label })]) };
    }
    function load() {
      return Promise.all([context.api('/api/v1/providers/status'), context.api('/api/v1/providers/location', { homeId: home.id })]).then(function (values) { status = values[0]; savedLocation = values[1]; render(); return status; });
    }
    function sourceError(error) {
      if (error && error.status === 503) context.tell('This connection is not available in this trial yet. Your assistant can still bring plans you choose.');
      else context.tell(ui.message(error));
    }
    function act(action, success) { context.run(function () { return Promise.resolve().then(action).catch(function (error) { sourceError(error); return null; }); }, function (value) { if (value !== null && success) return success(value); }); }
    function showPreview(kind, value) {
      preview = { kind: kind, value: bounded(value, kind), viewedAt: Date.now() };
      render();
    }
    function fetchPreview(kind) {
      var route = '/api/v1/providers/google/' + (kind === 'calendar' ? 'calendar' : 'inbox');
      return context.api(route, { timezone: timezone }).then(function (value) { showPreview(kind, value); });
    }

    function connectPanel() {
      var calendar = check('My main Google calendar', false, false);
      var inbox = check('Email subjects from my inbox', false, false);
      return ui.node('section', {}, [ui.node('h3', { text: status.connected ? 'Change your Google choices' : 'Bring your own plans' }), note('Choose what you want to connect. Nothing appears on a family screen until you allow it below.'), calendar.element, inbox.element, note('Email subjects can include private information. They may be seen by everyone in the room if you choose to share them.'), ui.button('Continue with Google', function () {
        if (!calendar.input.checked && !inbox.input.checked) { context.tell('Choose your calendar or inbox first.'); return; }
        act(function () { return context.api('/api/v1/providers/google/start', { calendar: calendar.input.checked, inbox: inbox.input.checked, calendarIds: calendar.input.checked ? ['primary'] : [] }); }, function (value) {
          var url = new URL(value.url);
          if (url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth' || url.username || url.password || url.hash) throw { status: 400 };
          window.location.assign(url.href);
        });
      })]);
    }

    function sharingPanel() {
      var sharing = status.sharing || {};
      var calendar = check('Calendar plans may appear on my screens', sharing.calendar, !status.calendar);
      var inbox = check('Email subjects may appear on my screens', sharing.inbox, !status.inbox);
      var result = ui.node('section', {}, [ui.node('h3', { text: 'What may appear at home?' }), note('Connecting and sharing are separate choices. You will preview each update before sending it.'), calendar.element, inbox.element, ui.button('Save my sharing choices', function () {
        act(function () { return context.api('/api/v1/providers/sharing', { calendar: Boolean(calendar.input.checked && status.calendar), inbox: Boolean(inbox.input.checked && status.inbox) }); }, function (value) { status = value; preview = null; render(); context.tell('Choices saved. Preview the information you want to bring home.'); });
      }, true)]);
      var previews = [];
      if (status.calendar) previews.push(ui.button('Preview my calendar', function () { act(function () { return fetchPreview('calendar'); }); }, true));
      if (status.inbox) previews.push(ui.button('Preview inbox reminders', function () { act(function () { return fetchPreview('inbox'); }); }, true));
      result.appendChild(buttons(previews));
      result.appendChild(ui.button('Disconnect Google', function () {
        if (!window.confirm('Disconnect Google? No new plans or inbox reminders will be read. Previously shared information stays until you remove it or it expires.')) return;
        act(function () { return context.api('/api/v1/providers/disconnect', {}); }, function (value) {
          preview = null;
          context.tell(value.revokedAtProvider ? 'Google is disconnected.' : 'Google is disconnected here. Also remove DisplayOS from your Google account to finish stopping access.');
          return load();
        });
      }, true));
      return result;
    }

    function clearLocal() { localGeneration++; localPreview = null; if (localTimer) window.clearTimeout(localTimer); localTimer = null; }

    function locationPanel() {
      var record = savedLocation && savedLocation.location;
      var input = ui.node('input', { type: 'text', maxlength: '240', autocomplete: 'off', 'aria-label': 'Home address or city', placeholder: 'City, region and country' });
      input.value = record ? record.address : '';
      var section = ui.node('section', { className: 'source-location' }, [ui.node('h3', { text: 'Around your home' }), ui.node('label', { className: 'field' }, [ui.node('span', { text: 'Home address or city' }), input]), note('Your full address stays private. If you allow it, we send it to Google to find your city. Only city weather and nearby places appear on your screens. We do not use your phone location.')]);
      function save(use, remove) {
        var address = remove ? '' : input.value.trim();
        if (!remove && (address.length < 3 || address.length > 240)) { context.tell('Enter a city or home address, up to 240 characters.'); return; }
        clearLocal();
        act(function () { return context.api('/api/v1/providers/location/save', { homeId: home.id, address: address, weather: use, nearby: use }); }, function (value) {
          savedLocation = value; render();
          context.tell(remove ? 'Home location removed. New weather and nearby updates are stopped.' : !use ? 'Home location saved privately. It is not being used on your screens.' : value.weatherAvailable || value.nearbyAvailable ? 'Location saved. Your screens will show city weather and nearby places when available.' : 'Location saved privately. Google information is not available in this trial yet.');
        });
      }
      var locationActions = buttons([ui.button('Use for weather and nearby places', function () { save(true, false); }), ui.button('Save privately', function () { save(false, false); }, true)]);
      locationActions.className += ' location-primary-actions';
      section.appendChild(locationActions);
      var unitActions = buttons(['celsius', 'fahrenheit'].map(function (unit) {
        var button = ui.button(unit === 'celsius' ? 'Celsius \u00b0C' : 'Fahrenheit \u00b0F', function () {
          var preferences = Object.assign({}, home.settings, { temperatureUnit: unit });
          act(function () { return context.api('/api/v1/home', { homeId: home.id, command: 'home.temperature', input: { temperatureUnit: unit } }); }, function () {
            home.settings = preferences; render(); context.tell('Temperature choice saved for your screens.');
          });
        }, (home.settings.temperatureUnit || 'celsius') !== unit);
        button.setAttribute('aria-pressed', String((home.settings.temperatureUnit || 'celsius') === unit));
        return button;
      }));
      unitActions.setAttribute('role', 'group'); unitActions.setAttribute('aria-label', 'Temperature units');
      section.appendChild(ui.node('p', { text: 'Show temperatures in' }));
      section.appendChild(unitActions);
      if (record) {
        var removalActions = buttons([ui.button('Remove home location', function () { save(false, true); }, true)]);
        removalActions.className += ' location-secondary-actions';
        section.appendChild(removalActions);
      }
      if (!savedLocation.weatherAvailable && !savedLocation.nearbyAvailable) section.appendChild(note('Weather and nearby places are not available in this trial yet. You can still save your location privately.'));
      if (record) section.appendChild(note(record.weather || record.nearby ? 'Weather and nearby places update on connected screens within about 30 seconds. During quiet hours, tap Show full display on the screen to see them.' : 'Saved privately. Not used for weather or nearby places. Choose Use for weather and nearby places to show them on your screens.'));
      var previewActions = buttons([]);
      previewActions.className += ' location-preview-actions';
      ['weather', 'nearby'].forEach(function (kind) {
        var button = ui.button(kind === 'weather' ? 'Preview weather' : 'Preview nearby places', function () {
          var version = savedLocation.version;
          var generation = localGeneration;
          act(function () { return context.api('/api/v1/providers/google/' + kind, { homeId: home.id }); }, function (value) {
            if (!panel.isConnected || document.hidden || window.navigator.onLine === false || localGeneration !== generation || savedLocation.version !== version || value.locationVersion !== version) return;
            var rows = value[kind];
            if (value.available !== true || value.ephemeral !== true || value.attribution !== ATTRIBUTION || !Array.isArray(value.thirdPartyAttributions) || value.thirdPartyAttributions.length || !Array.isArray(rows) || rows.length > (kind === 'weather' ? 7 : 3) || typeof value.cityLabel !== 'string' || !value.cityLabel.trim() || value.cityLabel.length > 80) throw { status: 400 };
            var expiresAt = localExpiry(value, Date.now());
            if (kind === 'weather') bounded(value, 'weather');
            else rows.forEach(function (row) { if (!row || typeof row.title !== 'string' || typeof row.when !== 'string' || row.title.length > 80 || row.when.length > 80) throw { status: 400 }; });
            clearLocal(); localPreview = { kind: kind, value: value };
            localTimer = window.setTimeout(function () { clearLocal(); if (panel.isConnected) render(); }, Math.max(0, expiresAt - Date.now()));
            render();
          });
        }, true);
        button.disabled = !record || record[kind] !== true || savedLocation[kind + 'Available'] !== true;
        previewActions.appendChild(button);
      });
      section.appendChild(previewActions);
      if (localPreview) {
        var value = localPreview.value;
        var kind = localPreview.kind;
        var lines = value[kind].map(function (row) { return kind === 'weather' ? row.label + ': ' + row.condition + ', ' + ui.temperatureRange(row.low, row.high, home.settings.temperatureUnit) : row.title + ': ' + row.when; });
        var local = ui.node('section', { className: 'source-preview google-local-preview' }, [ui.node('h3', { text: value.cityLabel }), lines.length ? ui.node('ul', {}, lines.map(function (line) { return ui.node('li', { text: line }); })) : note('No nearby places were returned.'), ui.node('p', { text: ATTRIBUTION, translate: 'no', className: 'google-attribution' })]);
        if (kind === 'weather') local.appendChild(ui.node('p', { text: 'Source: Includes weather data from Google', className: 'google-weather-source' }));
        local.appendChild(note('This live information is separate from saved family updates. Your screens can show it while connected.'));
        section.appendChild(local);
      }
      return section;
    }

    function previewPanel() {
      var value = preview.value;
      var children = [ui.node('h3', { text: 'Take a look before sharing' }), note('This is a private preview on your phone. It has not been sent to a screen.')];
      var lines = [];
      if (preview.kind === 'calendar') value.week.forEach(function (day) { day.events.forEach(function (event) { lines.push(day.date + ' · ' + event.time + ' · ' + event.title); }); });
      else if (preview.kind === 'inbox') value.reminders.forEach(function (item) { lines.push(item.title); });
      children.push(lines.length ? ui.node('ul', {}, lines.map(function (line) { return ui.node('li', { text: line }); })) : note('There is nothing to share from this source right now.'));
      var screens = home.screens || [];
      var select = ui.node('select', { 'aria-label': 'Screen for this update' }, screens.map(function (screen) { return ui.node('option', { value: screen.id, text: screen.name }); }));
      select.value = selectedScreen;
      if (screens.length) children.push(ui.node('label', { className: 'field' }, [ui.node('span', { text: 'Send to this screen' }), select]));
      else children.push(note('Add a screen to your home before sharing this update.'));
      var allowed = value.sharingAllowed === true && status.sharing && status.sharing[preview.kind];
      if (!allowed) children.push(note('Allow this information on your screens in the sharing choices above, then preview it again.'));
      children.push(note(preview.kind === 'inbox' ? 'This replaces the reminder list on that screen. Other family information stays as it is.' : preview.kind === 'calendar' ? 'This replaces the weekly plan on that screen. Other family information stays as it is.' : 'This replaces the forecast on that screen. Other family information stays as it is.'));
      var share = ui.button('Share to DisplayOS', function () {
        selectedScreen = select.value;
        if (!allowed || !screens.some(function (screen) { return screen.id === selectedScreen; })) { context.tell('Choose an available screen and allow this information first.'); return; }
        if (Date.now() - preview.viewedAt > 300000) { preview = null; render(); context.tell('That preview is old. Preview the information again before sharing.'); return; }
        var selected = preview;
        act(function () {
          return context.api('/api/v1/providers/status').then(function (fresh) {
            if (!fresh.connected || !fresh[selected.kind] || !fresh.sharing || !fresh.sharing[selected.kind]) throw { status: 403 };
            return context.command('family.current', { deviceId: selectedScreen });
          }).then(function (current) {
            if (!Number.isInteger(current.revision) || current.revision < 0) throw { status: 409 };
            var snapshot = update(current, selected, timezone, Date.now());
            var bytes = new Uint8Array(18); window.crypto.getRandomValues(bytes);
            var key = Array.prototype.map.call(bytes, function (byte) { return ('0' + byte.toString(16)).slice(-2); }).join('');
            return context.command('family.publish', { deviceId: selectedScreen, snapshot: snapshot, expectedRevision: current.revision, idempotencyKey: key });
          });
        }, function () { preview = null; render(); context.tell('Update sent. Your screen will confirm when it has shown it.'); return context.refresh(true); });
      });
      share.disabled = !allowed || !screens.length || !lines.length;
      children.push(share);
      return ui.node('section', { className: 'source-preview' }, children);
    }

    function render() {
      ui.clear(body);
      if (!status) { body.appendChild(note('Checking which connections are available…')); return; }
      body.appendChild(note('Your assistant can already share information you choose. These optional connections let you bring a few plans or reminders yourself.'));
      if (status.available === true || status.configured === true) {
        body.appendChild(connectPanel());
        if (status.connected) body.appendChild(sharingPanel());
      } else body.appendChild(note('Direct Google connection is not available in this trial yet. Your assistant can still share approved family plans.'));
      body.appendChild(locationPanel());
      if (preview) body.appendChild(previewPanel());
    }
    render();
    document.addEventListener('visibilitychange', function () { if (document.hidden) { clearLocal(); if (panel.isConnected) render(); } });
    window.addEventListener('offline', function () { clearLocal(); if (panel.isConnected) render(); });
    load().catch(function () { ui.clear(body); body.appendChild(note('We cannot check these optional connections right now. Your family screen and assistant connection are unchanged.')); });
    return panel;
  }
  window.DisplayOSSources = { mount: mount };
}());
