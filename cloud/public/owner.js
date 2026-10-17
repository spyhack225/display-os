(function () {
  'use strict';
  var ui = window.DeskUI;
  var element = ui.element; var show = ui.show; var status = ui.status;
  var active = false; var busy = false; var adding = false; var selected = ''; var view = null; var signature = '';
  function step(name) {
    ['signin', 'connect', 'agent'].forEach(function (value) {
      var item = element('progress-' + value);
      if (value === name) item.setAttribute('aria-current', 'step'); else item.removeAttribute('aria-current');
    });
  }
  function entry(container, title, details, label, handler) {
    var box = document.createElement('div'); box.className = 'entry';
    var heading = document.createElement('h3'); heading.textContent = title;
    var paragraph = document.createElement('p'); paragraph.textContent = details;
    box.appendChild(heading); box.appendChild(paragraph);
    if (handler) {
      var button = document.createElement('button'); button.type = 'button'; button.textContent = label;
      button.onclick = function () { button.disabled = true; handler(function () { button.disabled = false; }); };
      box.appendChild(button);
    }
    container.appendChild(box);
  }
  function deviceName(id) {
    var device = view.devices.filter(function (value) { return value.deviceId === id; })[0];
    return device ? device.name : 'Display ' + id;
  }
  function handoff(id) {
    selected = id;
    element('invitation-screen').textContent = 'For ' + deviceName(id);
    element('agent-instructions').value = 'Read ' + location.origin + '/pilot/skill.md and request access to display ' + id + '. Ask for display:read and content:write for 15 minutes. Wait for my approval, then publish a synthetic test card and check its render receipt. Do not ask for my owner key, activation key or private provider data.';
    element('test-agent').href = '/agent#' + id;
  }
  function layout() {
    var hasDevices = view.devices.length > 0;
    show('claim-panel', adding || !hasDevices); show('cancel-claim', adding && hasDevices);
    show('agent-panel', hasDevices && !adding); show('devices-panel', hasDevices && !adding); show('permissions-panel', hasDevices && !adding);
    step(adding || !hasDevices ? 'connect' : 'agent');
    if (hasDevices && !view.devices.some(function (device) { return device.deviceId === selected; })) selected = view.devices[0].deviceId;
    if (selected) handoff(selected);
  }
  function clearOwner() {
    active = false; ui.csrf = ''; view = null; signature = ''; selected = ''; adding = false;
    ['devices', 'requests', 'grants'].forEach(function (id) { element(id).textContent = ''; });
    element('agent-instructions').value = ''; element('claim-ticket').value = '';
    show('owner-controls', false); show('login-panel', true); step('signin');
  }
  function state() {
    if (busy) return; busy = true;
    ui.api('GET', '/api/owner/state', null, null, function (error, result, code) {
      busy = false;
      if (error) { if (active || code !== 401) status(error); if (code === 401) clearOwner(); return; }
      active = true; ui.csrf = result.csrfToken; view = result; show('login-panel', false); show('owner-controls', true); layout();
      var nextSignature = JSON.stringify(result);
      if (signature === nextSignature) return;
      signature = nextSignature;
      var requests = element('requests'); requests.textContent = result.requests.length ? '' : 'Your assistant has not asked to connect yet. Try the sample assistant to see how it works.';
      result.requests.forEach(function (request) {
        var scopes = request.scopes.map(function (scope) { return scope === 'display:read' ? 'see screen updates' : scope === 'content:write' ? 'send notes' : scope; }).join(' and ');
        entry(requests, 'Let ' + request.label + ' help?', 'It can ' + scopes + ' on ' + deviceName(request.deviceId) + ' for ' + Math.round(request.ttlSeconds / 60) + ' minutes. Names are supplied by the assistant. Only allow a request you recognize.', 'Yes, let it help', function (finish) {
          ui.api('POST', '/api/owner/requests/' + request.requestId + '/approve', { approved: true }, null, function (error) {
            finish(); status(error || 'Your assistant can now send its first note.'); state();
          });
        });
      });
      var devices = element('devices'); devices.textContent = '';
      result.devices.forEach(function (device) {
        var receipt = !device.latest ? 'Ready for its first note.' : device.latest.status === 'rendered' ? 'Your screen sent confirmation.' : device.latest.status === 'expired' ? 'Ready for a fresh note.' : 'Your note is on its way.';
        entry(devices, device.name, receipt, 'Invite my assistant here', function (finish) { handoff(device.deviceId); adding = false; layout(); finish(); element('agent-panel').scrollIntoView({ block: 'start' }); });
      });
      var grants = element('grants'); grants.textContent = result.grants.length ? '' : 'No assistant is connected yet.';
      result.grants.forEach(function (grant) {
        var stateLabel = grant.status === 'active' ? 'Helping until ' + new Date(grant.expiresAt).toLocaleTimeString() : 'No longer connected';
        var rights = grant.scopes.map(function (scope) { return scope === 'display:read' ? 'see updates' : 'send notes'; }).join(' and ');
        entry(grants, grant.label, deviceName(grant.deviceId) + ' · ' + stateLabel + '. Can ' + rights + '.', 'Stop updates', grant.status === 'active' ? function (finish) {
          ui.api('POST', '/api/owner/grants/' + grant.grantId + '/revoke', {}, null, function (error) { finish(); status(error || 'Your assistant can no longer send notes. Notes already on screen stay until they expire.'); state(); });
        } : null);
      });
    });
  }
  ui.submit('claim-form', function (finish) {
    var value = ui.ticket(element('claim-ticket').value);
    if (!value) { finish(); status('Enter all 12 letters and numbers from your screen.'); element('claim-ticket').focus(); return; }
    ui.api('POST', '/api/owner/claim', value, null, function (error, result) {
      finish(); if (error) { status(error); return; }
      selected = result.deviceId; adding = false; element('claim-ticket').value = ''; status('Your screen is yours. Next, invite your assistant.'); state();
    });
  });
  element('copy-agent').onclick = function () { ui.copy('agent-instructions', 'Invitation copied. Paste it into your conversation with your assistant.'); };
  element('add-display').onclick = function () { adding = true; layout(); element('claim-ticket').focus(); };
  element('cancel-claim').onclick = function () { adding = false; element('claim-ticket').value = ''; layout(); };
  element('logout').onclick = function () {
    element('logout').disabled = true;
    ui.api('POST', '/api/owner/logout', {}, null, function (error) {
      element('logout').disabled = false; status(error || 'Signed out.');
      if (!error) clearOwner(); else state();
    });
  };
  state(); setInterval(function () { if (active) state(); }, 5000);
}());
