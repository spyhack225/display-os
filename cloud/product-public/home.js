(function () {
  'use strict';
  var ui = window.DisplayOSUI;
  var root = document.getElementById('home-root');
  var notice = document.getElementById('message');
  var principal = null;
  var identityVersion = 0;
  var homes = [];
  var home = null;
  var selectedHome = null;
  var pendingClaim = null;
  var pendingConnections = [];
  var dismissedConnections = [];
  var view = 'signin';
  var signature = '';
  var busy = false;
  var lastTrigger = null;
  var chosenPhotos = [];
  var fragment = new URLSearchParams(location.hash.slice(1));
  var claimCode = fragment.get('claim') || fragment.get('pair') || '';
  var invitation = fragment.get('invite');
  var invitationHome = fragment.get('home');
  var connectionHandle = fragment.get('connect');
  var noticeTimer;
  var homeActivity = Date.now();
  function tell(text) { clearTimeout(noticeTimer); notice.textContent = text; notice.hidden = false; noticeTimer = setTimeout(function () { notice.hidden = true; }, 8000); }
  function setPrincipal(value) { principal = value; identityVersion++; }
  function api(path, body) {
    var version = identityVersion;
    return ui.request(path, { method: body === undefined ? 'GET' : 'POST', body: body, csrf: principal && principal.csrf }).then(function (value) {
      if (version !== identityVersion) throw { staleIdentity: true };
      return value;
    }, function (error) {
      if (version !== identityVersion) throw { staleIdentity: true };
      throw error;
    });
  }
  function command(name, input) { return api('/api/v1/home', { homeId: selectedHome, command: name, input: input || {} }); }
  function run(action, success, failure, options) {
    if (busy) return;
    busy = true;
    lastTrigger = document.activeElement;
    var buttons = Array.prototype.map.call(root.querySelectorAll('button'), function (button) { var saved = { button: button, disabled: button.disabled }; button.disabled = true; return saved; });
    Promise.resolve().then(action).then(function (value) { if (success) return success(value); }).catch(function (error) {
      if (error.staleIdentity) return;
      var keep = options && options.keepOn401 && error && error.status === 401;
      tell(failure ? failure(error) : ui.message(error));
      if (error.status === 401 && !keep) { setPrincipal(null); home = null; chosenPhotos = []; signature = ''; renderSignIn(); }
    }).finally(function () { busy = false; buttons.forEach(function (saved) { if (root.contains(saved.button)) saved.button.disabled = saved.disabled; }); });
  }
  function openModal(id, title, bodyNodes) {
    var previous = document.getElementById(id);
    if (previous) previous.remove();
    var opener = lastTrigger && root.contains(lastTrigger) ? lastTrigger : document.activeElement;
    var card = ui.node('section', { className: 'home-modal-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': id + '-title' }, [ui.node('h2', { id: id + '-title', text: title })].concat(bodyNodes));
    var backdrop = ui.node('div', { className: 'home-modal', id: id }, [card]);
    function close() { document.removeEventListener('keydown', key); backdrop.remove(); if (opener && root.contains(opener)) opener.focus(); }
    function key(event) {
      if (event.key === 'Escape') { event.preventDefault(); close(); return; }
      if (event.key === 'Tab') {
        var items = Array.prototype.filter.call(card.querySelectorAll('button, input, select, textarea, [href]'), function (element) { return !element.disabled; });
        if (!items.length) { event.preventDefault(); return; }
        var first = items[0]; var last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    }
    backdrop.addEventListener('click', function (event) { if (event.target === backdrop) close(); });
    document.addEventListener('keydown', key);
    root.appendChild(backdrop);
    return { backdrop: backdrop, card: card, close: close };
  }
  function askFresh(retry, what) {
    var modal;
    var confirm = ui.button('Confirm with passkey', function () { modal.close(); run(signIn, function () { tell('Confirmed. Trying again.'); setTimeout(retry, 50); }); });
    var cancel = ui.button('Not now', function () { modal.close(); }, true);
    modal = openModal('confirm-fresh', 'Confirm it is you.', [
      ui.node('p', { text: 'To ' + what + ', use your fingerprint, face or screen lock once more. This keeps your home safe if someone else picks up this phone or computer.' }),
      ui.node('p', { className: 'muted', text: 'Your home is unchanged. Nothing was sent yet.' }),
      actions([confirm, cancel])
    ]);
    confirm.focus();
  }
  function runFresh(action, success, failure, what) {
    run(action, success, function (error) {
      if (error && error.status === 401) {
        askFresh(function () { runFresh(action, success, failure, what); }, what);
        return 'Please confirm it is you to continue.';
      }
      return failure ? failure(error) : ui.message(error);
    }, { keepOn401: true });
  }
  function sheet(title, children) { return ui.node('section', { className: 'sheet' }, [ui.node('h2', { text: title })].concat(children || [])); }
  function actions(children) { return ui.node('div', { className: 'actions' }, children); }
  function progress(step) { return ui.node('ol', { className: 'progress', 'aria-label': 'Setup progress' }, ['Your home', 'Your screen', 'Your helper'].map(function (name, index) { return ui.node('li', { className: index === step ? 'current' : '', text: name, 'aria-current': index === step ? 'step' : 'false' }); })); }
  function headline(title, detail) { return [ui.node('p', { className: 'eyebrow', text: 'A little more together' }), ui.node('h1', { text: title }), ui.node('p', { className: 'lead', text: detail })]; }
  function replace(children) { ui.clear(root); root.setAttribute('data-view', view); children.forEach(function (child) { root.appendChild(child); }); }
  function supportsSignIn() { return window.PublicKeyCredential && window.SimpleWebAuthnBrowser; }
  function register(name) {
    return api('/auth/register/options', { name: name }).then(function (options) { return window.SimpleWebAuthnBrowser.startRegistration({ optionsJSON: options }); }).then(function (response) { return api('/auth/register/verify', response); }).then(signedIn);
  }
  function signIn() {
    return api('/auth/login/options', {}).then(function (options) {
      return Promise.resolve().then(function () { return window.SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: options }); }).then(function (response) {
        return api('/auth/login/verify', response).then(signedIn);
      }, function (error) {
        if (!error || (error.name !== 'NotAllowedError' && error.name !== 'AbortError')) throw error;
        showSignInHelp(error.name);
      });
    });
  }
  function showSignInHelp(errorName) {
    var previous = document.getElementById('signin-help');
    if (previous) previous.remove();
    clearTimeout(noticeTimer); notice.hidden = true;
    var panel = sheet(errorName === 'AbortError' ? 'Sign-in was interrupted.' : 'Sign-in did not finish.', [
      ui.node('p', { text: errorName === 'AbortError' ? 'The browser stopped this sign-in attempt. Use "I already have a home" to try again.' : 'The browser did not complete sign-in. Use "I already have a home" to try again.' }),
      ui.node('p', { text: 'You can open this page on the phone or computer where you saved your passkey. To stay here, choose another device in the browser\'s passkey prompt if that option is available.' }),
      ui.node('p', { text: 'Your existing home is unchanged. Trying again will not create a new account or reset it.' })
    ]);
    panel.id = 'signin-help'; panel.setAttribute('role', 'status'); panel.setAttribute('aria-live', 'polite'); panel.setAttribute('tabindex', '-1');
    root.appendChild(panel); panel.focus();
  }
  function signedIn(value) { setPrincipal(value); signature = ''; if (value.needsPasskey) { renderRecovered(); return Promise.resolve(); } return loadHomes(); }
  function renderSignIn() {
    view = 'signin';
    var name = ui.field('What should we call you?', 'your-name', 'text', '', { autocomplete: 'given-name', maxlength: '80', required: '', placeholder: 'Your first name' });
    var form = ui.node('form', { onSubmit: function (event) { event.preventDefault(); run(function () { return register(name.input.value.trim()); }); } }, [name.element, ui.node('button', { type: 'submit', className: 'button', text: 'Get started', disabled: !supportsSignIn() })]);
    var recoveryCode = ui.field('Your safety code', 'safety-code', 'text', '', { autocomplete: 'off', maxlength: '120', required: '' });
    var recovery = ui.node('details', {}, [ui.node('summary', { text: 'Lost access to your phone?' }), ui.node('p', { text: 'Use one of the safety codes you saved earlier. It works once. Your old ways to sign in will be removed to protect you if a phone was stolen.' }), ui.node('form', { onSubmit: function (event) { event.preventDefault(); run(function () { return api('/auth/login/options', {}).then(function () { return api('/auth/recovery/use', { code: recoveryCode.input.value.trim() }); }); }, function (value) { setPrincipal(value); renderRecovered(); }); } }, [recoveryCode.element, ui.node('button', { type: 'submit', className: 'button secondary', text: 'Use my safety code' })])]);
    replace(headline('Make yourself at home.', 'A calm place for your family, with just the things you want to share.').concat([ui.node('div', { className: 'signin-illustration', 'aria-hidden': 'true', text: '✳' }), sheet('Let us start with you.', [ui.node('p', { text: 'Your phone or computer will ask for your fingerprint, face or screen lock. No new password to remember.' }), form, actions([ui.button('I already have a home', function () { run(signIn); }, true)]), supportsSignIn() ? null : ui.node('p', { className: 'flow-note', text: 'Open this page on a newer phone or computer to sign in safely.' }), recovery]) ]));
  }
  function addSignIn() {
    return api('/auth/passkey/options', {}).then(function (options) { return window.SimpleWebAuthnBrowser.startRegistration({ optionsJSON: options }); }).then(function (response) { return api('/auth/passkey/verify', response); }).then(function (value) { setPrincipal(value); return value; });
  }
  function renderRecovered() {
    view = 'recovered';
    replace(headline('Welcome back.', 'Your old ways to sign in have been removed. Add a new one on this phone or computer before you leave.').concat([sheet('Save a new sign-in', [ui.node('p', { text: 'Your phone or computer will ask for your fingerprint, face or screen lock again.' }), ui.button('Save a new sign-in', function () { run(addSignIn, function () { tell('Your new sign-in is saved.'); return loadHomes(); }); })])]));
  }
  function renderCreateHome() {
    view = 'create';
    var name = ui.field('What is your home called?', 'home-name', 'text', 'Our home', { maxlength: '80', required: '' });
    replace(headline('A home for your people.', 'Give it a name that feels like yours.').concat([progress(0), sheet('Your home', [ui.node('form', { onSubmit: function (event) { event.preventDefault(); run(function () { return api('/api/v1/homes', { name: name.input.value.trim() }); }, function (value) {
      selectedHome = value.home.id;
      var zone = 'UTC'; try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (_) {}
      return command('home.get').then(function (created) { return command('home.update', { settings: Object.assign({}, created.settings, { timezone: zone }) }); }).then(loadHomes);
    }); } }, [name.element, ui.node('button', { type: 'submit', className: 'button', text: 'Make my home' })])]), safetyPanel(), ui.button('Sign out', logout, true)]));
  }
  function claimPanel() {
    var scanned = /^(?:[A-F0-9]{12}|[A-F0-9]{32})$/i.test(claimCode);
    var code = ui.field('Six numbers on your screen', 'screen-code', 'text', scanned ? '' : claimCode, { maxlength: '40', inputmode: 'numeric', autocomplete: 'off', spellcheck: 'false', placeholder: '123 456', required: '' });
    code.input.setAttribute('aria-describedby', 'screen-code-hint');
    code.input.setAttribute('aria-label', 'Six numbers on your screen');
    var slots = ui.node('div', { className: 'pair-slots', 'aria-hidden': 'true' }, [0, 1, 2, 3, 4, 5].map(function () { return ui.node('span', {}); }));
    var entry = ui.node('div', { className: 'pair-entry' }, [code.input, slots]);
    code.element.appendChild(entry);
    code.element.appendChild(ui.node('span', { id: 'screen-code-hint', className: 'muted', text: 'Type or paste all six numbers. They stay in the right order.' }));
    function updateSlots() {
      var normalized = code.input.value.replace(/[\s-]/g, '').toUpperCase();
      entry.classList.toggle('legacy-code', /[A-F]/.test(normalized));
      Array.prototype.forEach.call(slots.children, function (slot, index) { slot.textContent = normalized.charAt(index); slot.classList.toggle('active-slot', index === Math.min(normalized.length, 5)); });
    }
    code.input.addEventListener('input', updateSlots); updateSlots();
    var panel = sheet('Add your screen', [ui.node('p', { text: scanned ? 'Your phone found this screen. Tap below, then check the words on your screen.' : 'Scan the square with your phone camera, or type the six numbers shown on your screen.' }), ui.node('form', { onSubmit: function (event) {
      event.preventDefault();
      var input = (scanned ? claimCode : code.input.value).replace(/[\s-]/g, '').toUpperCase();
      if (!/^(?:[0-9]{6}|[A-F0-9]{12}|[A-F0-9]{32})$/.test(input)) { tell('Enter the six numbers shown on your screen.'); return; }
      run(function () { return api('/api/v1/claim', { code: input, homeId: selectedHome }); }, function (value) { pendingClaim = value; pendingClaim.expiresAt = value.expiresAt || Date.now() + 120000; claimCode = ''; history.replaceState(null, '', '/home'); renderHome(); });
    } }, [scanned ? null : code.element, ui.node('button', { type: 'submit', className: 'button', text: 'This is my screen' })]), ui.node('p', { className: 'muted', text: 'You will confirm once on the screen too, so nobody else can take it.' })]);
    if (home.screens.length) panel.appendChild(actions([ui.button('Back to my home', function () { view = 'home'; claimCode = ''; renderHome(); }, true)]));
    return panel;
  }
  function claimPendingPanel() {
    return sheet('One last tap on your screen.', [ui.node('p', { text: 'Check that your screen shows these same words.' }), ui.node('p', { className: 'phrase', text: pendingClaim.phrase }), ui.node('p', { text: 'Then tap "Yes, this is my home" on the screen. We will wait here.' }), ui.node('p', { className: 'muted', text: 'Not your screen? Do not confirm. The request will expire shortly.' })]);
  }
  function permissionLabel(scope) { return { 'display:read': 'See your screens and whether updates arrived', 'content:write': 'Add family plans and short updates', 'settings:write': 'Change the screen view and quiet hours', 'media:write': 'Add photos for this home' }[scope] || 'A permission we do not recognize'; }
  function assistantReturn(url) {
    var redirect = new URL(url);
    if (redirect.protocol !== 'https:' && !(redirect.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].indexOf(redirect.hostname) >= 0)) throw { status: 400 };
    return redirect.href;
  }
  function approvalPanel(intent) {
    var requested = intent.scopes || [];
    var boxes = requested.map(function (scope) { var box = ui.node('input', { type: 'checkbox', checked: scope === 'display:read' || scope === 'content:write', value: scope }); return { scope: scope, input: box, row: ui.node('label', { className: 'checkbox' }, [box, ui.node('span', { text: permissionLabel(scope) })]) }; });
    var screens = home.screens.map(function (screen) { var box = ui.node('input', { type: 'checkbox', checked: true }); return { id: screen.id, input: box, row: ui.node('label', { className: 'checkbox' }, [box, ui.node('span', { text: screen.name })]) }; });
    var title = intent.label || intent.clientName || intent.client_name || 'Your assistant';
    var duration = ui.node('select', { id: 'assistant-duration', name: 'assistant-duration', 'aria-label': 'How long can it help?' }, [ui.node('option', { value: '2592000', text: 'For 30 days' }), ui.node('option', { value: '86400', text: 'For today' })]);
    var durationNote = ui.node('p', { className: 'muted', text: 'It can help for 30 days. Stop it anytime.' });
    duration.addEventListener('change', function () { durationNote.textContent = duration.value === '86400' ? 'It can help for today. Stop it anytime.' : 'It can help for 30 days. Stop it anytime.'; });
    return sheet('Let this assistant help?', [ui.node('h3', { text: title }), ui.node('p', { className: 'flow-note', text: 'Only continue if you just asked this assistant to connect. This name is supplied by the assistant and is not proof of who it is.' }), ui.node('p', { text: 'Choose what it can do.' })].concat(boxes.map(function (item) { return item.row; }), [ui.node('p', { text: 'Choose the screens it can help with.' })], screens.map(function (item) { return item.row; }), [ui.node('label', { className: 'field', for: 'assistant-duration' }, [ui.node('span', { text: 'How long can it help?' }), duration]), durationNote, actions([ui.button('Allow this assistant', function () {
      var scopes = boxes.filter(function (item) { return item.input.checked; }).map(function (item) { return item.scope; });
      var deviceIds = screens.filter(function (item) { return item.input.checked; }).map(function (item) { return item.id; });
      if (!scopes.length || !deviceIds.length) { tell('Choose at least one thing it can do and one screen.'); return; }
      run(function () { return api('/api/v1/connections/approve', { intentId: intent.id || intent.intentId, homeId: selectedHome, deviceIds: deviceIds, scopes: scopes, duration: Number(duration.value) }); }, function (value) {
        location.assign(assistantReturn(value.redirectUrl));
      });
    }), ui.button('Not now', function () {
      var intentId = intent.id || intent.intentId;
      run(function () { return api('/api/v1/connections/deny', { intentId: intentId }).then(function (value) { if (!value.cancelled) throw { status: 409 }; return value; }); }, function (value) {
        var returnUrl = connectionHandle === intentId && value.redirectUrl ? assistantReturn(value.redirectUrl) : null;
        dismissedConnections.push(intentId); connectionHandle = null;
        pendingConnections = pendingConnections.filter(function (item) { return (item.id || item.intentId) !== intentId; });
        history.replaceState(null, '', '/home'); tell('This assistant request has been cancelled.'); renderHome();
        if (returnUrl) location.assign(returnUrl);
      });
    }, true)])]));
  }
  function assistantPanel() {
    var grants = home.grants || [];
    var address = location.origin + '/mcp';
    var connection = ui.field('Server URL', 'assistant-server-url', 'url', address, { readonly: '' });
    var setup = ui.node('details', {}, [ui.node('summary', { text: 'Setup steps' }), ui.node('ol', {}, [
      ui.node('li', { text: 'In ChatGPT on the web, choose +, then Add custom MCP server.' }),
      ui.node('li', { text: 'Name it DisplayOS and paste this address into Server URL.' }),
      ui.node('li', { text: 'Choose OAuth for authentication, not No authentication. If setup asks for keys or cannot continue, stop and ask for help.' }),
      ui.node('li', { text: 'Read the risk warning. If you want to continue, choose Create as a plugin.' }),
      ui.node('li', { text: 'Find your new DisplayOS plugin and install it. Then type @DisplayOS in your chat and select it.' }),
      ui.node('li', { text: 'When DisplayOS asks for approval, sign in in your own browser and choose the home, screens and access you want to allow.' })
    ]), connection.element, ui.node('p', { className: 'muted', text: 'Custom setup may not be available for your ChatGPT account or workspace. Pasting an invitation cannot enable it.' }), ui.node('p', { text: 'An assistant\'s cloud browser has a separate sign-in. Do not sign in there for it or share passkeys, safety codes, tokens or login cookies. Only you approve access.' })]);
    function selectAddress() { setup.open = true; connection.input.focus(); connection.input.select(); tell('Select and copy the Server URL, then paste it into ChatGPT setup.'); }
    var children = home.role === 'owner' ? [ui.node('p', { text: 'Add DisplayOS to ChatGPT first. Pasting an invitation does not install it.' }), ui.node('p', { className: 'muted', text: 'This pilot uses manual setup. You choose what your helper can share.' }), actions([
      ui.node('a', { className: 'button', href: 'https://chatgpt.com/plugins', target: '_blank', rel: 'noopener noreferrer', text: 'Open ChatGPT setup' }),
      ui.button('Copy connection address', function () { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(address).then(function () { tell('Connection address copied. Paste it into Server URL in ChatGPT setup.'); }).catch(selectAddress); else selectAddress(); }, true)
    ]), setup, actions([ui.button('Copy an invitation', function () {
      var invitationText = 'After the DisplayOS plugin is installed and selected in this chat, use it to bring my family plans to DisplayOS at ' + location.origin + '/home. Follow the assistant instructions at ' + location.origin + '/skill.md. If the secure connection is unavailable, explain that limitation and ask me to finish setup. I will sign in and approve access in my own browser. Do not sign in through your cloud browser, approve your own request or ask me to share passkeys, safety codes, tokens or login cookies. Keep passwords and private messages off the shared screen.';
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(invitationText).then(function () { tell('Invitation copied. After installing DisplayOS, select it in your chat and paste this invitation.'); }).catch(function () { showInvitation(invitationText); }); else showInvitation(invitationText);
    }, true)])] : [ui.node('p', { text: 'These helpers look after your screen. The person who manages your home chooses their permissions.' })];
    grants.forEach(function (grant) { children.push(ui.node('div', { className: 'list-row' }, [ui.node('h3', { text: grant.label || 'Your assistant' }), ui.node('span', { className: 'status-pill', text: 'Allowed until ' + new Date(grant.expiresAt).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) }), ui.node('ul', { className: 'connection-permissions' }, grant.scopes.map(function (scope) { return ui.node('li', { text: permissionLabel(scope) }); }))].concat(home.role === 'owner' ? [actions([ui.button('Stop this assistant', function () { run(function () { return api('/api/v1/connections/revoke', { homeId: selectedHome, grantId: grant.id }); }, function () { tell('This assistant can no longer update your screen.'); return refresh(true); }); }, true)])] : []))); });
    var panel = sheet(grants.length || home.role !== 'owner' ? 'Your helpers' : 'Invite your helper', children);
    panel.className += ' home-primary home-helper';
    return panel;
  }
  function showInvitation(text) { var field = ui.node('textarea', { readonly: '', rows: '6', 'aria-label': 'Invitation for your assistant', className: 'invitation-copy', text: text }); root.appendChild(sheet('Your invitation', [ui.node('p', { text: 'After DisplayOS is installed, select it in your chat, then copy and send these words. This invitation does not install it.' }), field])); field.select(); }
  function settingsPanel() {
    var current = home.settings;
    var title = ui.field('Home name', 'settings-name', 'text', home.name, { maxlength: '80', required: '' });
    var timezone = ui.field('Time zone', 'settings-timezone', 'text', current.timezone, { maxlength: '80', required: '', list: 'timezones' });
    var zones = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London', 'Europe/Paris', 'Asia/Shanghai', 'Asia/Tokyo', 'Australia/Sydney', 'UTC'];
    var datalist = ui.node('datalist', { id: 'timezones' }, zones.map(function (zone) { return ui.node('option', { value: zone }); }));
    var nightStart = ui.field('Quiet nights begin', 'night-start', 'time', current.nightStart, { required: '' });
    var nightEnd = ui.field('Morning begins', 'night-end', 'time', current.nightEnd, { required: '' });
    var idle = ui.field('Quiet view after this many minutes', 'quiet-minutes', 'number', String(current.quietAfterSeconds / 60), { min: '.5', max: '30', step: '.5', required: '' });
    var brightness = ui.field('Screen brightness', 'brightness', 'range', String(current.brightness), { min: '10', max: '100' });
    var orientation = ui.node('select', { id: 'screen-orientation' }, [['auto', 'Turn with the screen'], ['portrait', 'Tall view'], ['landscape', 'Wide view']].map(function (item) { return ui.node('option', { value: item[0], text: item[1] }); })); orientation.value = current.orientation;
    var photo = ui.node('input', { type: 'checkbox', checked: current.showPhotos });
    var form = ui.node('form', { onSubmit: function (event) { event.preventDefault(); var changedTimezone = timezone.input.value.trim() !== current.timezone; run(function () { return command('home.update', { name: title.input.value.trim(), settings: { timezone: timezone.input.value.trim(), quietAfterSeconds: Number(idle.input.value) * 60, nightStart: nightStart.input.value, nightEnd: nightEnd.input.value, brightness: Number(brightness.input.value), orientation: orientation.value, showPhotos: photo.checked, temperatureUnit: home.settings.temperatureUnit || 'celsius' } }); }, function () { tell(changedTimezone ? 'New plans will use this time zone. Your helper needs to send a fresh update.' : 'Your choices are saved.'); return refresh(true); }); } }, [title.element, timezone.element, datalist, nightStart.element, nightEnd.element, idle.element, brightness.element, ui.node('label', { className: 'field', for: 'screen-orientation' }, [ui.node('span', { text: 'Screen position' }), orientation]), ui.node('label', { className: 'checkbox' }, [photo, ui.node('span', { text: 'Show chosen photos in quiet view' })]), ui.node('p', { className: 'muted', text: 'Quiet hours show a dim clock, date and calendar. Tap Show full display on the screen to see your day without changing this schedule. Brightness and position need the DisplayOS screen app.' }), ui.node('button', { type: 'submit', className: 'button', text: 'Save my choices' })]);
    return ui.node('details', {}, [ui.node('summary', { text: 'Make it feel like home' }), form]);
  }
  function voiceSettingsPanel() {
    var grants = home.grants || [];
    var current = home.settings && home.settings.defaultVoiceAgent || '';
    var options = [ui.node('option', { value: '', text: 'No default — let me pick on the screen' })];
    grants.forEach(function (grant) {
      var name = grant.label || 'Your assistant';
      if (!options.some(function (option) { return option.value === name; })) options.push(ui.node('option', { value: name, text: name }));
    });
    var select = ui.node('select', { id: 'default-voice-agent' }, options);
    if (options.some(function (option) { return option.value === current; })) select.value = current;
    var form = ui.node('form', { className: 'screen-voice-agent', onSubmit: function (event) { event.preventDefault(); run(function () { return command('home.voiceDefault', { defaultVoiceAgent: select.value }); }, function () { tell('Your default voice helper is saved.'); return refresh(true); }); } }, [ui.node('label', { className: 'field', for: 'default-voice-agent' }, [ui.node('span', { text: 'Default helper' }), select]), ui.node('button', { type: 'submit', className: 'button secondary', text: 'Save my choice' })]);
    return ui.node('details', {}, [ui.node('summary', { text: 'Who answers when you speak' }), ui.node('p', { text: 'Pick which helper answers when someone speaks to one of your screens.' }), form]);
  }
  function preparePhoto(file) {
    if (!file || !/^image\/(jpeg|png|webp)$/.test(file.type)) return Promise.reject({ status: 400, photoReason: 'format' });
    if (file.size > 20000000) return Promise.reject({ status: 413, photoReason: 'large' });
    return new Promise(function (resolve, reject) {
      var image = new Image(); var url = URL.createObjectURL(file);
      image.onerror = function () { URL.revokeObjectURL(url); reject({ status: 400, photoReason: 'unreadable' }); };
      image.onload = function () {
        URL.revokeObjectURL(url);
        try {
        if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 50000000) { reject({ status: 400, photoReason: 'unreadable' }); return; }
        var ratio = Math.min(1, 1280 / Math.max(image.naturalWidth, image.naturalHeight));
        var canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio)); canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
        var context = canvas.getContext('2d');
        for (var attempt = 0; attempt < 10; attempt++) {
          context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0, canvas.width, canvas.height);
          for (var quality = 85; quality >= 55; quality -= 10) {
            var value = canvas.toDataURL('image/jpeg', quality / 100);
            var data = value.split(',')[1];
            if (value.indexOf('data:image/jpeg;base64,') === 0 && data.length <= 131072) { resolve({ data: data, mime: 'image/jpeg' }); return; }
          }
          canvas.width = Math.max(1, Math.floor(canvas.width * .75)); canvas.height = Math.max(1, Math.floor(canvas.height * .75));
        }
        reject({ status: 413 });
        } catch (_) { reject({ status: 400, photoReason: 'unreadable' }); }
      };
      image.src = url;
    });
  }
  function showChosenPhoto(mediaId) {
    return showChosenPhotos([mediaId]);
  }
  function showChosenPhotos(mediaIds) {
    var screens = home.screens.slice();
    var homeId = selectedHome; var activePrincipal = principal;
    if (!screens.length) return Promise.resolve({ shown: false });
    return screens.reduce(function (chain, screen) { return chain.then(function () {
      if (principal !== activePrincipal || selectedHome !== homeId) throw { staleIdentity: true };
      return command('family.current', { deviceId: screen.id }).then(function (current) {
        if (principal !== activePrincipal || selectedHome !== homeId) throw { staleIdentity: true };
        var now = Date.now();
        var snapshot = current.snapshot || { schemaVersion: 1, timezone: screen.settings && screen.settings.timezone || home.settings.timezone, briefing: { title: 'Our favorite faces', text: 'Photos chosen by your family.' }, weather: [], week: [], reminders: [], kids: [], parents: [], news: [], prompts: [], nearby: [], photos: [] };
        var added = mediaIds.filter(function (mediaId) { return snapshot.photos.indexOf(mediaId) < 0; });
        if (!added.length) return;
        if (snapshot.photos.length + added.length > 20) throw { status: 409 };
        snapshot = Object.assign({}, snapshot, { photos: snapshot.photos.concat(added), generatedAt: now, expiresAt: current.snapshot ? Math.min(current.snapshot.expiresAt, now + 3600000) : now + 3600000 });
        var bytes = crypto.getRandomValues(new Uint8Array(24)); var key = ''; for (var index = 0; index < bytes.length; index++) key += bytes[index].toString(16).padStart(2, '0');
        return command('family.publish', { deviceId: screen.id, snapshot: snapshot, expectedRevision: current.revision, idempotencyKey: key });
      });
    }); }, Promise.resolve()).then(function () { return { shown: true }; });
  }
  function photosPanel() {
    var input = ui.node('input', { type: 'file', multiple: '', accept: 'image/jpeg,image/png,image/webp', className: 'photo-picker', id: 'chosen-photo' });
    var share = ui.node('input', { type: 'checkbox', checked: true });
    var catalog = ui.node('div', { className: 'photo-catalog' });
    var status = ui.node('p', { id: 'photo-status', role: 'status', 'aria-live': 'polite', hidden: '' });
    var details = ui.node('details', {}, [ui.node('summary', { text: 'Favorite faces' }), ui.node('p', { text: 'Choose several photos you would be happy for everyone at home to see. We share smaller copies, without the original file details.' }), ui.node('label', { className: 'checkbox' }, [share, ui.node('span', { text: 'Show chosen photos in quiet view on my screens' })]), ui.node('p', { className: 'muted', text: 'Save up to 20 photos. Quiet view shows them full-screen, changing gently every 30 seconds. Your family plans stay as they are.' }), input, actions([ui.button('Choose photos', function () { input.click(); }, true), ui.button('Show all in quiet view', function () { var ids = chosenPhotos.filter(function (photo) { return photo.homeId === selectedHome; }).map(function (photo) { return photo.mediaId; }); if (!ids.length) { tell('Choose some photos first.'); return; } run(function () { return showChosenPhotos(ids); }, function (value) { tell(value.shown ? 'Your slideshow has been sent to your screens.' : 'Add a screen before choosing where these photos appear.'); }); }, true)]), status, catalog]);
    function draw() {
      ui.clear(catalog);
      var entries = chosenPhotos.filter(function (photo) { return photo.homeId === selectedHome; });
      if (!entries.length) { catalog.appendChild(ui.node('p', { className: 'muted', text: 'Your chosen photos will appear here.' })); return; }
      entries.forEach(function (photo) { catalog.appendChild(ui.node('div', { className: 'list-row' }, [(photo.preview ? ui.node('img', { className: 'photo-thumb', src: photo.preview, alt: 'A photo you chose' }) : ui.node('p', { text: 'A chosen family photo' })), actions([ui.button('Show in quiet view', function () { run(function () { return showChosenPhoto(photo.mediaId); }, function (value) { tell(value.shown ? 'Your chosen photo has been sent to your screens.' : 'Add a screen before choosing where this photo appears.'); }); }, true), ui.button('Remove this photo', function () { if (!confirm('Remove this photo from your home and its screens?')) return; run(function () { return command('media.delete', { mediaId: photo.mediaId }); }, function () { chosenPhotos = chosenPhotos.filter(function (item) { return item !== photo; }); draw(); tell('This photo has been removed from your home.'); }); }, true)])])); });
    }
    function loadCatalog() {
      var activePrincipal = principal; var homeId = selectedHome;
      catalog.textContent = 'Opening your chosen photos...';
      command('media.list').then(function (value) {
        if (principal !== activePrincipal || selectedHome !== homeId || !root.contains(catalog)) return;
        var old = chosenPhotos;
        chosenPhotos = old.filter(function (photo) { return photo.homeId !== homeId; }).concat(value.photos.map(function (photo) { var previous = old.filter(function (item) { return item.homeId === homeId && item.mediaId === photo.mediaId; })[0]; return Object.assign({ homeId: homeId }, photo, previous && previous.preview ? { preview: previous.preview } : {}); }));
        draw();
        value.photos.forEach(function (photo) {
          var entry = chosenPhotos.filter(function (item) { return item.homeId === homeId && item.mediaId === photo.mediaId; })[0];
          if (entry.preview) return;
          command('media.get', { mediaId: photo.mediaId }).then(function (image) { if (principal !== activePrincipal || selectedHome !== homeId || !root.contains(catalog) || ['image/jpeg', 'image/png'].indexOf(image.mime) < 0 || image.data.length > 131072) return; entry.preview = 'data:' + image.mime + ';base64,' + image.data; draw(); }).catch(function () {});
        });
      }).catch(function (error) { if (root.contains(catalog)) catalog.textContent = ui.message(error); });
    }
    details.addEventListener('toggle', function () { if (details.open) loadCatalog(); });
    input.addEventListener('change', function () {
      if (!input.files.length || busy) return;
      var files = Array.prototype.slice.call(input.files); var activePrincipal = principal; var homeId = selectedHome; var showOnScreens = share.checked;
      status.hidden = false; status.textContent = 'Making a smaller copy of your photo...';
      run(function () {
        var saved = []; var failures = []; var stopped = false;
        var chain = files.length > 20 ? Promise.reject({ photoReason: 'selection' }) : files.reduce(function (chain, file, index) { return chain.then(function () {
          if (stopped) return;
          if (principal !== activePrincipal || selectedHome !== homeId) throw { staleIdentity: true };
          status.textContent = 'Saving photo ' + (index + 1) + ' of ' + files.length + '...';
          return preparePhoto(file).then(function (photo) {
            if (principal !== activePrincipal || selectedHome !== homeId) throw { staleIdentity: true };
            return command('media.upload', photo).then(function (value) {
              if (principal !== activePrincipal || selectedHome !== homeId) throw { staleIdentity: true };
              saved.push(value.mediaId);
              chosenPhotos.push({ homeId: homeId, mediaId: value.mediaId, preview: 'data:image/jpeg;base64,' + photo.data }); draw();
            });
          }).catch(function (error) {
            if (error.staleIdentity || error.status === 401 || error.status === 403) throw error;
            failures.push(error);
            if (error.status === 0 || error.status === 429 || error.status >= 500) stopped = true;
          });
        }); }, Promise.resolve());
        return chain.then(function () {
          if (principal !== activePrincipal || selectedHome !== homeId) throw { staleIdentity: true };
          if (!saved.length) throw failures[0];
          var result = { saved: saved.length, total: files.length, incomplete: saved.length !== files.length, shown: false };
          if (!showOnScreens) return result;
          return showChosenPhotos(saved).then(function (value) { result.shown = value.shown; return result; }).catch(function (error) { if (error.staleIdentity || error.status === 401 || error.status === 403) throw error; result.failed = true; return result; });
        }).finally(function () { input.value = ''; });
      }, function (value) { draw(); status.textContent = value.total === 1 ? value.failed ? 'Your photo is saved, but could not be added to every screen. Try "Show in quiet view" again.' : value.shown ? 'Your chosen photo has been sent to your screens.' : 'Photo saved for your assistant to use. Only this chosen photo was shared.' : 'Saved ' + value.saved + ' of ' + value.total + ' photos. ' + (value.incomplete ? 'Some photos could not be saved. Choose those photos again to retry. ' : '') + (value.failed ? 'Your photos are saved. Try "Show all in quiet view" to send them to your screens.' : value.shown ? 'Your slideshow has been sent to your screens.' : 'Your chosen photos are ready.'); }, function (error) {
        status.textContent = error.photoReason === 'selection' ? 'Choose up to 20 photos at a time.' : error.photoReason === 'large' ? 'This photo is too large to open. Choose a photo smaller than 20 MB.' : error.photoReason === 'format' || error.photoReason === 'unreadable' ? 'We could not open this photo. Try another JPEG, PNG or WebP photo.' : error.status === 429 && error.data && error.data.error === 'Please remove a photo before adding another.' ? 'Your photo collection is full. Remove a photo, then try again.' : error.status === 400 || error.status === 413 || error.status === 415 ? 'We could not make a small copy of this photo. Try another photo.' : ui.message(error);
        return status.textContent;
      });
    });
    return details;
  }
  function newListId() {
    var bytes = crypto.getRandomValues(new Uint8Array(9));
    var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    var id = '';
    for (var index = 0; index < bytes.length; index++) id += alphabet.charAt(bytes[index] % alphabet.length);
    return id;
  }
  function listsPanel() {
    var draft = [];
    var loaded = false;
    var catalog = ui.node('div', { className: 'lists-catalog' });
    var status = ui.node('p', { id: 'lists-status', role: 'status', 'aria-live': 'polite', hidden: '' });
    var details = ui.node('details', {}, [ui.node('summary', { text: 'Family lists' }), ui.node('p', { text: 'Groceries and to-dos for the whole family. Add items here or ask your helper. Tick items off as you go.' }), catalog, status]);
    function cleanLists(value) {
      return (value || []).map(function (entry) {
        return { id: entry.id, title: entry.title, kind: entry.kind, items: (entry.items || []).map(function (item) {
          var clean = { id: item.id, text: item.text, done: item.done === true };
          if (item.person) clean.person = item.person;
          return clean;
        }) };
      });
    }
    function draw() {
      ui.clear(catalog);
      if (!loaded) { catalog.appendChild(ui.node('p', { className: 'muted', text: 'Opening your lists...' })); return; }
      if (!draft.length) catalog.appendChild(ui.node('p', { className: 'muted', text: 'No lists yet. Create a groceries or to-do list below.' }));
      draft.forEach(function (entry) {
        var block = ui.node('div', { className: 'list-row' }, [ui.node('h3', { text: (entry.kind === 'groceries' ? '🛒 ' : '✅ ') + entry.title })]);
        (entry.items || []).forEach(function (item) {
          var box = ui.node('input', { type: 'checkbox', checked: item.done, 'aria-label': 'Done: ' + item.text });
          box.addEventListener('change', function () { item.done = box.checked; });
          var label = ui.node('label', { className: 'checkbox' }, [box, ui.node('span', { text: item.text + (item.person ? ' · ' + item.person : '') })]);
          block.appendChild(ui.node('div', { className: 'list-item-row' }, [label, ui.button('Remove', function () { entry.items = entry.items.filter(function (candidate) { return candidate !== item; }); draw(); }, true)]));
        });
        var itemText = ui.field('New item', 'list-item-' + entry.id, 'text', '', { maxlength: '80', placeholder: 'Milk' });
        var itemPerson = ui.field('For whom (optional)', 'list-person-' + entry.id, 'text', '', { maxlength: '80', placeholder: 'Everyone' });
        block.appendChild(ui.node('div', { className: 'list-add' }, [itemText.element, itemPerson.element, ui.button('Add item', function () {
          var text = itemText.input.value.trim();
          if (!text) { tell('Write the item first.'); itemText.input.focus(); return; }
          if (entry.items.length >= 12) { tell('This list is full at 12 items.'); return; }
          entry.items.push({ id: newListId(), text: text, person: itemPerson.input.value.trim(), done: false });
          draw();
        }, true)]));
        block.appendChild(actions([ui.button('Delete this list', function () { if (!confirm('Delete "' + entry.title + '" and its items?')) return; draft = draft.filter(function (candidate) { return candidate !== entry; }); draw(); }, true)]));
        catalog.appendChild(block);
      });
      if (draft.length < 4) {
        var title = ui.field('New list', 'new-list-title', 'text', '', { maxlength: '40', placeholder: 'Groceries' });
        var kind = ui.node('select', { id: 'new-list-kind', 'aria-label': 'List kind' }, [ui.node('option', { value: 'groceries', text: '🛒 Groceries' }), ui.node('option', { value: 'todo', text: '✅ To do' })]);
        catalog.appendChild(ui.node('div', { className: 'list-row' }, [ui.node('h3', { text: 'Start a new list' }), title.element, ui.node('label', { className: 'field', for: 'new-list-kind' }, [ui.node('span', { text: 'Kind' }), kind]), actions([ui.button('Create list', function () {
          var name = title.input.value.trim();
          if (!name) { tell('Name the list first.'); title.input.focus(); return; }
          draft.push({ id: newListId(), title: name, kind: kind.value === 'todo' ? 'todo' : 'groceries', items: [] });
          draw();
        }, true)])]));
      }
      catalog.appendChild(actions([ui.button('Send lists to screens', function () {
        if (!home.screens.length) { tell('Add a screen before sending lists.'); return; }
        var snapshot = cleanLists(draft);
        status.hidden = false; status.textContent = 'Sending your lists...';
        run(function () { return publishLists(snapshot); }, function (value) {
          status.textContent = 'Your lists are on ' + value.sent + (value.sent === 1 ? ' screen.' : ' screens.');
        }, function (error) { status.textContent = ui.message(error); return status.textContent; });
      })]));
    }
    function publishLists(snapshot) {
      var screens = home.screens.slice();
      var homeId = selectedHome; var activePrincipal = principal;
      if (!screens.length) return Promise.resolve({ sent: 0 });
      return screens.reduce(function (chain, screen) { return chain.then(function () {
        if (principal !== activePrincipal || selectedHome !== homeId) throw { staleIdentity: true };
        function attempt(again) {
          return command('family.current', { deviceId: screen.id }).then(function (current) {
            if (principal !== activePrincipal || selectedHome !== homeId) throw { staleIdentity: true };
            var now = Date.now();
            var base = current.snapshot || { schemaVersion: 1, timezone: home.settings.timezone, briefing: { title: 'Family lists', text: 'Lists kept by your family.' }, weather: [], week: [], reminders: [], kids: [], parents: [], news: [], prompts: [], nearby: [], photos: [], lists: [] };
            var next = Object.assign({}, base, { lists: snapshot, generatedAt: now, expiresAt: current.snapshot ? Math.min(current.snapshot.expiresAt, now + 3600000) : now + 3600000 });
            var bytes = crypto.getRandomValues(new Uint8Array(24)); var key = ''; for (var index = 0; index < bytes.length; index++) key += bytes[index].toString(16).padStart(2, '0');
            return command('family.publish', { deviceId: screen.id, snapshot: next, expectedRevision: current.revision, idempotencyKey: key }).catch(function (error) {
              if (error && error.status === 409 && !again) return attempt(true);
              throw error;
            });
          });
        }
        return attempt(false);
      }); }, Promise.resolve()).then(function () { return { sent: screens.length }; });
    }
    function load() {
      var homeId = selectedHome; var activePrincipal = principal;
      loaded = false; draw();
      if (!home.screens.length) { loaded = true; draft = []; draw(); return; }
      command('family.current', { deviceId: home.screens[0].id }).then(function (current) {
        if (principal !== activePrincipal || selectedHome !== homeId || !root.contains(catalog)) return;
        draft = cleanLists(current.snapshot && current.snapshot.lists);
        loaded = true; draw();
      }).catch(function (error) {
        if (principal !== activePrincipal || selectedHome !== homeId || !root.contains(catalog)) return;
        loaded = true; draft = []; draw(); tell(ui.message(error));
      });
    }
    details.addEventListener('toggle', function () { if (details.open) load(); });
    return details;
  }
  function peoplePanel() {
    var children = [ui.node('p', { text: 'Invite another grown-up to help look after your home.' })];
    home.members.forEach(function (member) { children.push(ui.node('div', { className: 'list-row' }, [ui.node('h3', { text: member.name }), ui.node('p', { text: member.role === 'owner' ? 'Looks after this home' : 'Can help with family updates' })].concat(home.role === 'owner' && member.role !== 'owner' ? [ui.button('Remove ' + member.name, function () { if (!confirm('Remove ' + member.name + ' from this home?')) return; runFresh(function () { return command('member.remove', { accountId: member.accountId }); }, function () { return refresh(true); }, null, 'remove someone from your home'); }, true)] : []))); });
    if (home.role === 'owner') children.push(actions([ui.button('Invite a grown-up', function () { runFresh(function () { return command('member.invite'); }, function (value) {
      var link = location.origin + '/home#invite=' + encodeURIComponent(value.code) + '&home=' + encodeURIComponent(selectedHome);
      showInviteLink(link);
      if (navigator.share) navigator.share({ title: 'Join our home on DisplayOS', url: link }).then(function () { tell('Invitation ready. Send it privately. It works once and lasts one day.'); }).catch(function () {});
      else if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(function () { tell('Invitation copied. Send it privately. It works once and lasts one day.'); }).catch(function () {});
    }, null, 'invite someone you trust'); }, true)]));
    return ui.node('details', {}, [ui.node('summary', { text: 'The people in your home' })].concat(children));
  }
  function showShareLink(link) { showInviteLink(link); }
  function showInviteLink(link) {
    var input = ui.field('Private invitation', 'private-invitation', 'text', link, { readonly: '' });
    var copy = ui.button('Copy invitation', function () {
      function done() { tell('Invitation copied. Send it privately. It works once and lasts one day.'); }
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(done, function () { input.input.focus(); input.input.select(); });
      else { input.input.focus(); input.input.select(); }
    }, true);
    var modal;
    var buttons = [copy].concat(navigator.share ? [ui.button('Share...', function () { navigator.share({ title: 'Join our home on DisplayOS', url: link }).catch(function () {}); }, true)] : []);
    modal = openModal('invite-link', 'Invite someone you trust', [
      ui.node('p', { text: 'Copy this invitation and send it privately. It works once and lasts one day.' }),
      input.element,
      actions(buttons.concat([ui.button('Done', function () { modal.close(); }, true)]))
    ]);
    input.input.focus(); input.input.select();
  }
  function download(value) { var url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })); var link = ui.node('a', { href: url, download: 'displayos-home.json' }); document.body.appendChild(link); link.click(); link.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 1000); }
  function safetyPanel() {
    return ui.node('details', {}, [ui.node('summary', { text: 'Your sign-in and safety' }), ui.node('p', { text: 'You can add another way to sign in, or save safety codes in case you lose your phone.' }), actions([ui.button('Add another sign-in', function () { run(addSignIn, function () { tell('Another sign-in has been added.'); }); }, true), ui.button('Make safety codes', function () { if (!confirm('Make new safety codes? Any older safety codes will stop working.')) return; run(function () { return api('/auth/recovery/create', {}); }, function (value) { root.appendChild(sheet('Save these somewhere private', [ui.node('p', { text: 'Each code works once. They will not be shown again. Do not send them to an assistant.' }), ui.node('div', { className: 'safety-codes' }, (value.codes || []).map(function (code) { return ui.node('div', { text: code }); })), ui.button('I have saved them', function () { renderHome(); })])); }); }, true)]), ui.node('hr', { className: 'section-divider' }), ui.button('Delete my account', function () { if (!confirm('Delete your account and the homes you manage? All family information and assistant access in those homes will be removed. This cannot be undone.')) return; run(function () { return api('/auth/account/delete', {}); }, function () { setPrincipal(null); home = null; homes = []; selectedHome = null; pendingClaim = null; chosenPhotos = []; replace(headline('Your account has been deleted.', 'The homes you managed and their family information have been removed.').concat([ui.node('a', { className: 'button', href: '/welcome', text: 'Back to DisplayOS' })])); }); }, true)]);
  }
  function screensPanel() {
    var children = home.screens.map(function (screen) {
      var content = [ui.node('div', { className: 'screen-card-heading' }, [ui.node('span', { className: 'screen-symbol', 'aria-hidden': 'true' }), ui.node('div', {}, [ui.node('h3', { text: screen.name }), ui.node('p', { className: 'screen-label', text: 'Screen ' + screen.id.slice(-6).toUpperCase() })])]), ui.node('p', { className: 'muted', text: screen.revision ? 'Family updates have been sent.' : 'Ready for your first family update.' })];
      if (home.role === 'owner') {
        var name = ui.field('Screen name', 'screen-name-' + screen.id, 'text', screen.name, { maxlength: '40', required: '', placeholder: 'Kitchen or living room' });
        content.push(ui.node('form', { className: 'screen-rename', onSubmit: function (event) { event.preventDefault(); run(function () { return command('screen.rename', { deviceId: screen.id, name: name.input.value.trim() }); }, function () { tell('Your screen name is saved.'); return refresh(true); }); } }, [name.element, ui.node('button', { type: 'submit', className: 'button secondary', text: 'Save screen name' })]));
        var allowBox = ui.node('input', { type: 'checkbox', checked: screen.allowListEdits === true });
        allowBox.addEventListener('change', function () { run(function () { return command('screen.lists', { deviceId: screen.id, allowListEdits: allowBox.checked }); }, function () { tell(allowBox.checked ? 'Anyone at this screen can now edit family lists.' : 'List editing from this screen is off.'); return refresh(true); }); });
        content.push(ui.node('div', { className: 'screen-lists-toggle' }, [ui.node('label', { className: 'checkbox' }, [allowBox, ui.node('span', { text: 'Let this screen edit family lists' })]), ui.node('p', { className: 'muted', text: 'Anyone touching the screen can add, tick off and remove items.' })]));
        var voiceBox = ui.node('input', { type: 'checkbox', checked: screen.allowVoice === true });
        voiceBox.addEventListener('change', function () { run(function () { return command('screen.voice', { deviceId: screen.id, allowVoice: voiceBox.checked }); }, function () { tell(voiceBox.checked ? 'Anyone at this screen can now speak to your helper.' : 'Voice recording at this screen is off.'); return refresh(true); }); });
        content.push(ui.node('div', { className: 'screen-lists-toggle screen-voice-toggle' }, [ui.node('label', { className: 'checkbox' }, [voiceBox, ui.node('span', { text: 'Let this screen record voice' })]), ui.node('p', { className: 'muted', text: 'Anyone touching the screen can speak to your helper. Voice is sent to your helper and deleted after a day.' })]));
        content.push(ui.button('Remove this screen', function () { if (!confirm('Remove ' + screen.name + ' from your home? It will clear your family information before someone else can add it.')) return; run(function () { return api('/api/v1/screens/reset', { homeId: selectedHome, deviceId: screen.id }); }, function () { tell('Screen removed. It will clear your information when it reconnects.'); return refresh(true); }); }, true));
      }
      return ui.node('article', { className: 'screen-card' }, content);
    });
    if (!children.length) children.push(ui.node('p', { className: 'muted', text: 'Your first screen will appear here after you add it.' }));
    if (home.role === 'owner') children.push(actions([ui.button('Add another screen', function () { view = 'claim'; renderHome(); }, true)]));
    var panel = sheet('Your screens', children);
    panel.className += ' home-primary home-screens';
    return panel;
  }
  function demoPanel() { return ui.node('details', {}, [ui.node('summary', { text: 'Try it on this computer' }), ui.node('p', { text: 'This browser can act as a practice screen. Practice screens stay with your sign-in and forget their screen connection when you close the tab. This is not a prepared tablet.' }), ui.button('Try this screen', function () { runFresh(function () { return api('/api/v1/demo-screen', {}); }, function (value) { sessionStorage.setItem('displayos-demo-device-token', value.deviceToken); sessionStorage.setItem('displayos-demo-device-key', JSON.stringify({ deviceId: value.deviceId, publicKey: value.publicKey, privateKey: value.privateKey })); location.assign('/screen'); }, null, 'try a practice screen'); }, true)]); }
  function renderHome() {
    if (!home || invitation && invitationHome) return;
    if (view !== 'claim') view = 'home';
    var children = [ui.node('section', { className: 'home-intro' }, [ui.node('p', { className: 'eyebrow', text: 'A little more together' }), ui.node('h1', { text: home.name }), ui.node('p', { className: 'lead', text: home.screens.length ? 'Your screens, your helper, and the little things that make a day.' : 'Add a screen, then invite the helper you trust.' }), ui.node('p', { className: 'home-count', text: home.screens.length ? home.screens.length + (home.screens.length === 1 ? ' screen in your home' : ' screens in your home') : 'A home for your people' })])];
    if (homes.length > 1) {
      var selector = ui.node('select', { id: 'choose-home', 'aria-label': 'Choose your home' }, homes.map(function (item) { return ui.node('option', { value: item.id, text: item.name }); })); selector.value = selectedHome;
      selector.addEventListener('change', function () { selectedHome = selector.value; pendingClaim = null; signature = ''; refresh(true); }); children.push(ui.node('label', { className: 'field', for: 'choose-home' }, [ui.node('span', { text: 'Your home' }), selector]));
    }
    if (!home.screens.length) children.push(progress(1));
    if (pendingClaim) children.push(claimPendingPanel());
    else if ((view === 'claim' || !home.screens.length || claimCode) && home.role === 'owner') children.push(claimPanel());
    var intents = pendingConnections.filter(function (intent) { return dismissedConnections.indexOf(intent.id || intent.intentId) < 0 && (!connectionHandle || intent.id === connectionHandle || intent.intentId === connectionHandle); });
    if (home.screens.length) {
      if (home.role === 'owner') intents.forEach(function (intent) { children.push(approvalPanel(intent)); });
      else if (intents.length) children.push(sheet('A grown-up needs to allow this.', [ui.node('p', { text: 'The person who manages this home chooses its helpers. Ask them to connect this assistant, or choose a home you look after.' })]));
      children.push(screensPanel(), assistantPanel());
    }
    if (home.role === 'owner' && window.DisplayOSSources) {
      var sources = window.DisplayOSSources.mount({ ui: ui, home: home, principal: principal, api: api, command: command, tell: tell, run: run, refresh: refresh });
      sources.open = home.screens.length > 0; sources.className += (home.screens.length ? ' home-primary' : '') + ' home-sources'; children.push(sources);
    }
    if (home.role === 'owner') children.push(settingsPanel(), voiceSettingsPanel(), photosPanel(), listsPanel(), ui.node('p', { className: 'muted', text: 'Spoken requests go to your helper. You will see answers on the screen.' }));
    children.push(peoplePanel());
    if (!home.screens.length) children.push(screensPanel());
    if (home.role === 'owner') children.push(ui.node('details', {}, [ui.node('summary', { text: 'Your information' }), ui.node('p', { text: 'Keep a copy of the information in your home, or make a fresh start.' }), actions([ui.button('Download home information', function () { run(function () { return command('home.export'); }, download); }, true), ui.button('Delete this home', function () { if (!confirm('Delete this home and all its family information? Its screens will be cleared and its assistants stopped. This cannot be undone.')) return; runFresh(function () { return command('home.delete'); }, function () { selectedHome = null; home = null; return loadHomes(); }, null, 'delete your home'); }, true)])]), demoPanel());
    children.push(safetyPanel(), actions([ui.button('Sign out', logout, true)]));
    replace(children);
  }
  function logout() { run(function () { return api('/auth/logout', {}); }, function () { setPrincipal(null); home = null; homes = []; selectedHome = null; pendingConnections = []; dismissedConnections = []; pendingClaim = null; chosenPhotos = []; signature = ''; renderSignIn(); }); }
  var refreshing = null;
  function refresh(force) {
    if (!principal || !selectedHome || refreshing && refreshing.principal === principal && refreshing.homeId === selectedHome) return Promise.resolve();
    var active = { principal: principal, homeId: selectedHome };
    refreshing = active;
    return Promise.all([command('home.get'), api('/api/v1/connections/pending')]).then(function (values) {
      if (principal !== active.principal || selectedHome !== active.homeId) return;
      var previousScreens = home && home.screens.length || 0;
      home = values[0]; pendingConnections = values[1].intents || values[1].pending || values[1].requests || [];
      if (pendingClaim && home.screens.length > previousScreens) { pendingClaim = null; view = 'home'; tell('Your screen is part of your home.'); }
      var nextSignature = JSON.stringify([home, pendingConnections, pendingClaim]);
      var editing = root.contains(document.activeElement) && ['INPUT', 'SELECT', 'TEXTAREA'].indexOf(document.activeElement.tagName) >= 0;
      var opened = root.querySelector('details[open]:not(.home-sources)');
      if (force || (nextSignature !== signature && !editing && !opened)) { signature = nextSignature; renderHome(); }
    }).catch(function (error) { if (error.staleIdentity || principal !== active.principal || selectedHome !== active.homeId) return; if (error.status === 401) { setPrincipal(null); renderSignIn(); } else if (force) tell(ui.message(error)); }).finally(function () { if (refreshing === active) refreshing = null; });
  }
  function loadHomes() {
    var activePrincipal = principal;
    return api('/api/v1/homes').then(function (value) {
      if (principal !== activePrincipal) return;
      homes = value.homes;
      if (invitation && invitationHome) {
        view = 'invited';
        var code = invitation; var id = invitationHome;
        replace(headline('You are invited.', 'Someone you know has invited you to help look after their home.').concat([sheet('Join their home?', [ui.node('p', { text: 'Only join if this invitation came from someone you trust.' }), actions([ui.button('Join this home', function () { run(function () { return api('/api/v1/invitations/accept', { code: code, homeId: id }); }, function () { invitation = null; invitationHome = null; selectedHome = id; history.replaceState(null, '', '/home'); return loadHomes(); }); }), ui.button('Not now', function () { invitation = null; invitationHome = null; history.replaceState(null, '', '/home'); loadHomes(); }, true)])])]));
        return;
      }
      if (!homes.length) { renderCreateHome(); return; }
      if (!selectedHome || !homes.some(function (item) { return item.id === selectedHome; })) selectedHome = homes[0].id;
      return refresh(true);
    }).catch(function (error) { if (error.staleIdentity || principal !== activePrincipal) return; throw error; });
  }
  window.addEventListener('hashchange', function () {
    fragment = new URLSearchParams(location.hash.slice(1));
    var nextClaim = fragment.get('claim') || fragment.get('pair') || '';
    if (nextClaim !== claimCode) pendingClaim = null;
    claimCode = nextClaim;
    invitation = fragment.get('invite'); invitationHome = fragment.get('home');
    connectionHandle = fragment.get('connect');
    signature = '';
    if (claimCode) view = 'claim';
    if (principal && view !== 'recovered') {
      if (home && !invitation) renderHome();
      loadHomes().catch(function (error) { if (!error.staleIdentity) tell(ui.message(error)); });
    }
  });
  api('/api/v1/me').then(signedIn).catch(function (error) { if (error.staleIdentity) return; if (error.status === 401) renderSignIn(); else { renderSignIn(); tell(ui.message(error)); } });
  document.addEventListener('pointerdown', function () { homeActivity = Date.now(); });
  document.addEventListener('keydown', function () { homeActivity = Date.now(); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { homeActivity = Date.now(); refresh(false); } });
  setInterval(function () {
    if (document.hidden) return;
    if (pendingClaim && pendingClaim.expiresAt <= Date.now()) { pendingClaim = null; signature = ''; tell('That screen request expired. Use the new code on your screen.'); renderHome(); }
    var waiting = pendingClaim || pendingConnections.some(function (intent) { return intent.expiresAt > Date.now(); });
    if ((view === 'home' || view === 'claim') && (waiting || Date.now() - homeActivity < 120000)) refresh(false);
  }, 5000);
}());
