import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { sampleSnapshot, validateSnapshot } from '../src/product/family.js';

const root = new URL('../product-public/', import.meta.url);
const screenAssets = Object.fromEntries(await Promise.all(['common.js', 'screen.js', 'design-system.css', 'style.css', 'details.css', 'pairing.css'].map(async filename => [filename, await readFile(new URL(filename, root), 'utf8')])));
const homeCommon = await readFile(new URL('../product-public/common.js', import.meta.url), 'utf8');
const homeSource = await readFile(new URL('../product-public/home.js', import.meta.url), 'utf8');
const screenOrigin = 'https://lists-screen.example.com';
const homeOrigin = 'https://lists-home.example.com';
const now = Date.parse('2026-10-10T16:00:00Z');

function listsSnapshot() {
  return {
    ...sampleSnapshot(now),
    briefing: { title: 'Lists day', text: 'Approved for this screen' },
    lists: [
      { id: 'groceries-01', title: 'Groceries', kind: 'groceries', items: [
        { id: 'item-0001', text: 'Milk', person: 'Everyone', done: false },
        { id: 'item-0002', text: 'Eggs', done: true },
        { id: 'item-0003', text: 'Bread', done: false },
        { id: 'item-0004', text: 'Apples', person: 'Sam', done: false },
      ] },
      { id: 'todo-list-01', title: 'Weekend jobs', kind: 'todo', items: [
        { id: 'item-0011', text: 'Fix the shelf', person: 'Sam', done: false },
      ] },
    ],
  };
}

async function withScreen(callback) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.setDefaultTimeout(4000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const envelope = {
      state: 'owned', revision: 1, nonce: 'fixture-nonce', homeName: 'Fixture home', screenName: 'Kitchen', screenIdentifier: 'ABC123',
      settings: { timezone: 'UTC', nightStart: '07:00', nightEnd: '07:00', quietAfterSeconds: 1800, showPhotos: false, temperatureUnit: 'celsius' },
      localRevision: 1, localEnabled: { weather: false, nearby: false },
      snapshot: listsSnapshot(),
    };
    await page.route(screenOrigin + '/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/screen') {
        await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body class="display"><main id="screen-root"></main><p id="screen-status" role="status"></p></body></html>' });
        return;
      }
      if (path.startsWith('/product/')) {
        const filename = path.slice('/product/'.length);
        await route.fulfill({ contentType: 'text/css', body: screenAssets[filename] || '' });
        return;
      }
      if (path === '/device/v1/poll') await route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope) });
      else if (path === '/device/v1/ack') await route.fulfill({ contentType: 'application/json', body: '{}' });
      else await route.fulfill({ status: 400, contentType: 'application/json', body: '{}' });
    });
    await page.goto(screenOrigin + '/screen');
    await page.clock.install({ time: new Date(now) });
    await page.evaluate(() => sessionStorage.setItem('displayos-demo-device-token', 'fixture-display-token'));
    await page.addScriptTag({ content: screenAssets['common.js'] });
    await page.addScriptTag({ content: screenAssets['screen.js'] });
    await page.getByRole('button', { name: 'See all Family lists', exact: true }).waitFor();
    await callback({ page });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
}

test('family lists tile filters by kind and opens every item', async () => {
  await withScreen(async ({ page }) => {
    await page.getByText('Milk', { exact: true }).waitFor();
    await page.getByText('Fix the shelf', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Show groceries', exact: true }).click();
    assert.equal(await page.getByText('Fix the shelf', { exact: true }).count(), 0);
    await page.getByText('Milk', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Show to-dos', exact: true }).click();
    assert.equal(await page.getByText('Milk', { exact: true }).count(), 0);
    await page.getByText('Fix the shelf', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Show all lists', exact: true }).click();
    await page.getByText('Milk', { exact: true }).waitFor();
    await page.locator('.family-tile.lists-tile').click();
    const dialog = page.getByRole('dialog', { name: 'Family lists', exact: true });
    await dialog.waitFor();
    for (const text of ['Milk', 'Eggs', 'Bread', 'Apples', 'Fix the shelf']) assert.match(await dialog.textContent(), new RegExp(text));
  });
});

test('family lists tile stays friendly without any lists', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.setDefaultTimeout(4000);
    const envelope = {
      state: 'owned', revision: 1, nonce: 'fixture-nonce', homeName: 'Fixture home', screenName: 'Kitchen', screenIdentifier: 'ABC123',
      settings: { timezone: 'UTC', nightStart: '07:00', nightEnd: '07:00', quietAfterSeconds: 1800, showPhotos: false, temperatureUnit: 'celsius' },
      localRevision: 1, localEnabled: { weather: false, nearby: false },
      snapshot: { ...listsSnapshot(), lists: [] },
    };
    await page.route(screenOrigin + '/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/screen') {
        await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body class="display"><main id="screen-root"></main><p id="screen-status" role="status"></p></body></html>' });
        return;
      }
      if (path === '/device/v1/poll') await route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope) });
      else if (path === '/device/v1/ack') await route.fulfill({ contentType: 'application/json', body: '{}' });
      else await route.fulfill({ status: 400, contentType: 'application/json', body: '{}' });
    });
    await page.goto(screenOrigin + '/screen');
    await page.clock.install({ time: new Date(now) });
    await page.evaluate(() => sessionStorage.setItem('displayos-demo-device-token', 'fixture-display-token'));
    await page.addScriptTag({ content: screenAssets['common.js'] });
    await page.addScriptTag({ content: screenAssets['screen.js'] });
    await page.getByText('🛒 No lists yet. Add groceries or to-dos from home.', { exact: true }).waitFor();
  } finally {
    await browser.close();
  }
});

async function withEditableScreen(allowed, callback) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.setDefaultTimeout(4000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const edits = [];
    const envelope = {
      state: 'owned', revision: 1, nonce: 'fixture-nonce', homeName: 'Fixture home', screenName: 'Kitchen', screenIdentifier: 'ABC123',
      allowListEdits: allowed,
      settings: { timezone: 'UTC', nightStart: '07:00', nightEnd: '07:00', quietAfterSeconds: 1800, showPhotos: false, temperatureUnit: 'celsius' },
      localRevision: 1, localEnabled: { weather: false, nearby: false },
      snapshot: listsSnapshot(),
    };
    await page.route(screenOrigin + '/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/screen') {
        await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body class="display"><main id="screen-root"></main><p id="screen-status" role="status"></p></body></html>' });
        return;
      }
      if (path === '/device/v1/poll') await route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope) });
      else if (path === '/device/v1/ack') await route.fulfill({ contentType: 'application/json', body: '{}' });
      else if (path === '/device/v1/lists') {
        edits.push(route.request().postDataJSON());
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ revision: 2, status: 'accepted' }) });
      }
      else await route.fulfill({ status: 400, contentType: 'application/json', body: '{}' });
    });
    await page.goto(screenOrigin + '/screen');
    await page.clock.install({ time: new Date(now) });
    await page.evaluate(() => sessionStorage.setItem('displayos-demo-device-token', 'fixture-display-token'));
    await page.addScriptTag({ content: screenAssets['common.js'] });
    await page.addScriptTag({ content: screenAssets['screen.js'] });
    await page.getByRole('button', { name: 'See all Family lists', exact: true }).waitFor();
    await page.locator('.family-tile.lists-tile').click();
    await page.getByRole('dialog', { name: 'Family lists', exact: true }).waitFor();
    await callback({ page, edits });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
}

test('an allowed screen adds, ticks and removes items from the lists modal', async () => {
  await withEditableScreen(true, async ({ page, edits }) => {
    await page.getByPlaceholder('Add milk...').first().fill('Butter');
    await page.getByPlaceholder('For whom (optional)').first().fill('Alex');
    const added = page.waitForResponse(screenOrigin + '/device/v1/lists');
    await page.getByRole('button', { name: 'Add', exact: true }).first().click();
    await (await added).finished();
    assert.equal(edits.length, 1);
    assert.equal(edits[0].action, 'add');
    assert.equal(edits[0].listId, 'groceries-01');
    assert.equal(edits[0].item.text, 'Butter');
    assert.equal(edits[0].item.person, 'Alex');
    assert.match(edits[0].item.id, /^[A-Za-z0-9]{8,64}$/);
    assert.equal(edits[0].expectedRevision, 1);
    const toggled = page.waitForResponse(screenOrigin + '/device/v1/lists');
    await page.getByRole('checkbox', { name: 'Done: Milk' }).click();
    await (await toggled).finished();
    assert.deepEqual([edits[1].action, edits[1].itemId], ['toggle', 'item-0001']);
    const removed = page.waitForResponse(screenOrigin + '/device/v1/lists');
    await page.getByRole('button', { name: 'Remove', exact: true }).first().click();
    await (await removed).finished();
    assert.deepEqual([edits[2].action, edits[2].itemId], ['remove', 'item-0001']);
  });
});

test('a read-only screen shows lists without any editing controls', async () => {
  await withEditableScreen(false, async ({ page, edits }) => {
    await page.getByText('Ask an owner to allow editing from this screen to add items here.', { exact: true }).waitFor();
    assert.equal(await page.getByPlaceholder('Add milk...').count(), 0);
    assert.equal(await page.locator('.list-edit-row input[type=checkbox]').count(), 0);
    assert.equal(edits.length, 0);
  });
});

test('owner adds a grocery item on the home page and sends it to screens', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const publications = [];
    const home = { id: 'fixture-home', name: 'Fixture family', role: 'owner', members: [], screens: [{ id: 'fixture-screen', name: 'Kitchen' }], grants: [], settings: { timezone: 'UTC', nightStart: '22:00', nightEnd: '07:00', quietAfterSeconds: 300, brightness: 60, orientation: 'auto', showPhotos: true } };
    const current = { revision: 7, snapshot: { ...sampleSnapshot(Date.now()), lists: [] } };
    await page.route(homeOrigin + '/**', async route => {
      const path = new URL(route.request().url()).pathname;
      let value = {};
      if (path === '/home') {
        await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><main id="home-root"></main><p id="message" role="status" hidden></p></body></html>' });
        return;
      }
      if (path === '/api/v1/me') value = { account: { id: 'fixture-owner', name: 'Fixture owner' }, csrf: 'fixture-csrf' };
      else if (path === '/api/v1/homes') value = { homes: [{ id: home.id, name: home.name }] };
      else if (path === '/api/v1/connections/pending') value = { intents: [] };
      else if (path === '/api/v1/home') {
        const body = route.request().postDataJSON();
        if (body.command === 'home.get') value = home;
        else if (body.command === 'family.current') value = current;
        else if (body.command === 'family.publish') {
          assert.equal(body.input.expectedRevision, current.revision);
          validateSnapshot(body.input.snapshot, Date.now());
          publications.push(body.input.snapshot.lists);
          current.revision += 1; current.snapshot = body.input.snapshot; value = { accepted: true };
        } else throw new Error('Unexpected fixture command');
      } else throw new Error('Unexpected fixture path');
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
    });
    await page.goto(homeOrigin + '/home');
    await page.clock.install();
    await page.addScriptTag({ content: homeCommon });
    await page.addScriptTag({ content: homeSource });
    await page.getByText('Family lists', { exact: true }).click();
    await page.getByText('No lists yet. Create a groceries or to-do list below.', { exact: true }).waitFor();
    await page.getByLabel('New list').fill('Groceries');
    await page.getByRole('button', { name: 'Create list', exact: true }).click();
    await page.getByPlaceholder('Milk').fill('Milk');
    await page.getByPlaceholder('Everyone').fill('Sam');
    await page.getByRole('button', { name: 'Add item', exact: true }).click();
    await page.getByText('Milk · Sam', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Send lists to screens', exact: true }).click();
    await page.getByText('Your lists are on 1 screen.', { exact: true }).waitFor();
    assert.equal(publications.length, 1);
    assert.equal(publications[0].length, 1);
    assert.equal(publications[0][0].kind, 'groceries');
    assert.deepEqual(publications[0][0].items.map(item => [item.text, item.person, item.done]), [['Milk', 'Sam', false]]);
    await page.getByRole('checkbox', { name: 'Done: Milk' }).check();
    await page.getByRole('button', { name: 'Send lists to screens', exact: true }).click();
    await page.getByText('Your lists are on 1 screen.', { exact: true }).waitFor();
    assert.equal(publications.length, 2);
    assert.equal(publications[1][0].items[0].done, true);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
