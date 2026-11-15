const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const path = require('node:path');
const {after, before, test} = require('node:test');
const {chromium} = require('playwright');

const mainScript = readFileSync(path.join(__dirname, '../extension/main.js'), 'utf8');
const shadyScript = readFileSync(require.resolve('@webcomponents/shadydom/shadydom.min.js'), 'utf8');
let browser;

before(async () => {
	browser = await chromium.launch({headless: true});
});

after(async () => {
	await browser?.close();
});

async function createPage(t) {
	const page = await browser.newPage();
	const errors = [];
	page.on('pageerror', error => errors.push(error.stack));
	t.after(async () => {
		await page.close();
		assert.deepEqual(errors, [], 'no uncaught exceptions or rejected promises');
	});
	await page.goto('about:blank');
	await page.evaluate(() => {
		window.sinkChanges = [];
		window.APV3_UN1QU3_activeSinkId = 'test-speaker';
		HTMLMediaElement.prototype.setSinkId = async function(sinkId) {
			window.sinkChanges.push({id: this.id, sinkId});
		};
	});
	return page;
}

async function enableShadyDOM(page) {
	await page.evaluate(() => { window.ShadyDOM = {force: true}; });
	await page.addScriptTag({content: shadyScript});
	assert.equal(await page.evaluate(() => window.ShadyDOM.inUse), true);
}

async function expectSink(page, id, sinkId = 'test-speaker') {
	await page.waitForFunction(({id, sinkId}) =>
		window.sinkChanges.some(change => change.id === id && change.sinkId === sinkId),
		{id, sinkId}, {timeout: 5000});
}

test('ShadyDOM attachShadow returns its root and allows login fields to render', async t => {
	const page = await createPage(t);
	await enableShadyDOM(page);
	await page.addScriptTag({content: mainScript});
	const result = await page.evaluate(() => {
		const host = document.createElement('div');
		document.body.appendChild(host);
		const root = host.attachShadow({mode: 'open'});
		root.innerHTML = '<form><input autocomplete="username"><input type="password" autocomplete="current-password"></form>';
		window.ShadyDOM.flush();
		return {
			sameRoot: root === host.shadowRoot,
			username: !!root.querySelector('input[autocomplete="username"]'),
			password: !!root.querySelector('input[type="password"]'),
		};
	});
	assert.deepEqual(result, {sameRoot: true, username: true, password: true});
});

test('ShadyDOM media added later is detected and responds to device changes', async t => {
	const page = await createPage(t);
	await enableShadyDOM(page);
	await page.addScriptTag({content: mainScript});
	await page.evaluate(() => {
		const host = document.createElement('div');
		document.body.appendChild(host);
		const root = host.attachShadow({mode: 'open'});
		const audio = document.createElement('audio');
		audio.id = 'shady-audio';
		root.appendChild(audio);
		window.ShadyDOM.flush();
	});
	await expectSink(page, 'shady-audio');
	await page.evaluate(() => window.dispatchEvent(new CustomEvent('changeSinkId', {detail: 'other-speaker'})));
	await expectSink(page, 'shady-audio', 'other-speaker');
});

test('ShadyDOM hosts present before AudioPick do not reject asynchronous traversal', async t => {
	const page = await createPage(t);
	await enableShadyDOM(page);
	await page.evaluate(() => {
		window.host = document.createElement('div');
		const root = window.host.attachShadow({mode: 'open'});
		root.innerHTML = '<audio id="existing-shady-audio"></audio>';
		document.body.appendChild(window.host);
		window.ShadyDOM.flush();
	});
	await page.addScriptTag({content: mainScript});
	await page.evaluate(async () => {
		await APV3_UN1QU3_recursiveSetSinkId(window.host);
	});
	await expectSink(page, 'existing-shady-audio');
});

test('ShadyDOM loaded after AudioPick keeps dynamically rendered media working', async t => {
	const page = await createPage(t);
	await page.addScriptTag({content: mainScript});
	await enableShadyDOM(page);
	await page.evaluate(() => {
		const host = document.createElement('div');
		const root = host.attachShadow({mode: 'open'});
		root.innerHTML = '<audio id="late-shady-audio"></audio>';
		document.body.appendChild(host);
		window.ShadyDOM.flush();
	});
	await expectSink(page, 'late-shady-audio');
});

test('native open and closed shadow roots still detect dynamically added media', async t => {
	const page = await createPage(t);
	await page.addScriptTag({content: mainScript});
	for (const mode of ['open', 'closed']) {
		await page.evaluate(mode => {
			const host = document.createElement('div');
			document.body.appendChild(host);
			const root = host.attachShadow({mode});
			const nestedHost = document.createElement('div');
			root.appendChild(nestedHost);
			const nestedRoot = nestedHost.attachShadow({mode});
			nestedRoot.innerHTML = `<audio id="native-${mode}-audio"></audio>`;
		}, mode);
		await expectSink(page, `native-${mode}-audio`);
	}
});

test('invalid native attachShadow calls still throw the original browser exception', async t => {
	const page = await createPage(t);
	await page.addScriptTag({content: mainScript});
	assert.equal(await page.evaluate(() => {
		try {
			document.createElement('input').attachShadow({mode: 'open'});
		} catch (error) {
			return error.name;
		}
	}), 'NotSupportedError');
});
