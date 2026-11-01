import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { Push } from "./channels";
import { APP_ORIGIN } from "./window";

/**
 * Put the smoke account's session into the renderer before the assertions run.
 *
 * The app opens on a login screen, so a self-test that started from a cleared profile would have
 * nothing to assert against. The token is minted by the smoke backend in this process and written
 * to the same localStorage key the real login writes; the reload then takes the ordinary
 * "restore my session" path, which is exactly the code a person exercises.
 */
export async function seedSmokeSession(win: BrowserWindow, token: string): Promise<void> {
  const loaded = (): Promise<void> =>
    new Promise((resolve) => {
      // A missed event must not hang the whole self-test; the assertions will fail instead.
      const timer = setTimeout(resolve, 20_000);
      win.webContents.once("did-finish-load", () => {
        clearTimeout(timer);
        resolve();
      });
    });

  const onAppOrigin = (): boolean => {
    const url = win.webContents.getURL();
    if (url.startsWith(APP_ORIGIN)) return true;
    const devServer = process.env.AEGIS_DEV_SERVER;
    return Boolean(devServer) && url.startsWith(devServer as string);
  };

  // `createMainWindow` starts the load but may not have begun it yet, so an empty URL is a
  // "wait", not a "ready".
  if (!onAppOrigin()) await loaded();

  try {
    console.log(`[aegis-smoke] seeding session on ${win.webContents.getURL()}`);
    await win.webContents.executeJavaScript(
      `localStorage.setItem("aegis.auth.token.v1", ${JSON.stringify(token)})`,
    );
  } catch (error) {
    console.error("[aegis-smoke] could not seed the smoke session", error);
    return;
  }

  try {
    const check = await fetch("http://127.0.0.1:8787/api/auth/session", {
      headers: { authorization: `Bearer ${token}` },
    });
    console.log(`[aegis-smoke] session endpoint: ${check.status}`);
  } catch (error) {
    console.error("[aegis-smoke] session endpoint unreachable", error);
  }

  const next = loaded();
  win.webContents.reload();
  await next;
  console.log("[aegis-smoke] session seeded");
}

/**
 * A self-contained end-to-end proof that the bridge works in the *running* app - packaged
 * or not. Invoked with AEGIS_SMOKE=1.
 *
 * This replaces the Playwright smoke test in docs/02 section 10 for this slice: it exercises
 * the same properties (three methods exactly, frozen bridge, no `window.require`, push
 * delivery, fail-closed validation) without downloading a browser, so it also runs offline.
 *
 * Results go to stdout and to <temp>/aegis-smoke.json, because a packaged Windows GUI app has
 * no console attached. Exit code is 0 only when every assertion holds.
 */

const SETUP = `window.__aegisSmoke = (async () => {
  const out = {
    hasBridge: false,
    frozen: false,
    methods: [],
    nodeRequire: typeof window.require,
    push: 'unset',
    badInputRejected: false,
    validCall: 'unset'
  };
  const api = window.aegis;
  out.hasBridge = Boolean(api);
  if (!api) return out;

  out.frozen = Object.isFrozen(api);
  out.methods = Object.keys(api).sort();

  out.push = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 2000);
    const off = api.subscribe('window:focusChanged', (payload) => {
      clearTimeout(timer);
      off();
      resolve(payload && payload.focused === true ? 'delivered' : 'bad-payload');
    });
  });

  try {
    await api['files:saveExport']({ suggestedName: 'smoke.json', bytes: 'not-a-uint8array' });
    out.badInputRejected = false;
  } catch (error) {
    out.badInputRejected = true;
  }

  try {
    await api['files:revealInFolder']({ path: 'C:/definitely-not-here/aegis-smoke' });
    out.validCall = 'ok';
  } catch (error) {
    out.validCall = 'threw: ' + (error && error.message ? error.message : String(error));
  }

  // The shell has to have *rendered*, not merely loaded: the feed fetches with simulated
  // latency, so poll for the first painted rows instead of sampling once.
  const waitFor = async (test, timeout) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (test()) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  };

  await waitFor(
    () =>
      Boolean(
        document.querySelector(
          '[data-testid="empty-workspace"], [data-testid="boot-error"], [data-testid="channel-list"]',
        ),
      ),
    8000,
  );

  out.ui = {
    rail: Boolean(document.querySelector('[data-testid="guild-rail"]')),
    emptyState: Boolean(document.querySelector('[data-testid="empty-workspace"]')),
    channelRows: document.querySelectorAll('[data-testid="channel-row"]').length,
    channelName: (document.querySelector('[data-testid="channel-name"]') || {}).textContent || null,
    feed: Boolean(document.querySelector('[data-testid="message-feed"]')),
    messageRows: document.querySelectorAll('[data-testid="message-row"]').length,
    composer: Boolean(document.querySelector('[data-testid="composer-input"]')),
    memberRail: Boolean(document.querySelector('[data-testid="member-rail"]')),
    // The strict CSP forbids inline styles; a non-zero count means someone emitted one.
    inlineStyles: document.querySelectorAll('[style]').length,
    voiceChannels: 0,
    voiceStage: false,
    voiceConnected: false,
    voiceMuted: false,
    voiceCamera: false,
    voiceLeft: false,
    settingsModal: false,
    settingsProfile: false,
    settingsStatus: false,
    settingsVoice: false,
    displayNameUpdated: false,
    settingsPersisted: false,
    settingsClosed: false,
    serverSettings: false,
    serverDescription: false,
    serverIconUpload: false,
    serverNotifications: false,
    serverNotifyPersisted: false,
    serverMutedRail: false,
    roleRows: 0,
    profileCard: false,
    sentMessage: false,
    inlineStylesAfterAll: -1
  };

  /*
   * Drive the create-server dialog for real. A button that only opens a modal proves nothing, so
   * this walks the whole flow and then asserts on the rail, the route and the (empty) feed.
   */
  const addButton = document.querySelector('[data-testid="add-server"]');
  out.ui.addServerButton = Boolean(addButton);
  out.ui.createdServer = false;
  out.ui.createdChannelIsGeneral = false;
  out.ui.createdRows = -1;
  out.ui.modalClosed = false;
  out.ui.inlineStylesAfterModal = -1;

  if (addButton) {
    addButton.click();
    await waitFor(() => document.querySelector('[data-testid="template-tile"]'), 2000);

    const tile = document.querySelector('[data-testid="template-tile"]');
    if (tile) tile.click();

    await waitFor(() => document.querySelector('[data-testid="server-name-input"]'), 2000);
    const input = document.querySelector('[data-testid="server-name-input"]');
    const submit = document.querySelector('[data-testid="create-server-submit"]');

    if (input && submit) {
      // React owns the input's value on the node, so the native setter is the only honest write.
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'Smoke Guild');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 80));

      out.ui.inlineStylesAfterModal = document.querySelectorAll('[style]').length;
      submit.click();

      out.ui.createdServer = await waitFor(
        () => Boolean(document.querySelector('[data-testid="guild-rail"] [aria-label="Smoke Guild"]')),
        4000
      );
      out.ui.createdChannelIsGeneral = await waitFor(
        () => (document.querySelector('[data-testid="channel-name"]') || {}).textContent === 'general',
        2000
      );

      // Let the first page settle (a real HTTP round trip) before counting rows.
      await new Promise((resolve) => setTimeout(resolve, 400));
      out.ui.createdRows = document.querySelectorAll('[data-testid="message-row"]').length;
      out.ui.modalClosed = !document.querySelector('[data-testid="create-server-modal"]');
      out.ui.rail = Boolean(document.querySelector('[data-testid="guild-rail"]'));
      out.ui.channelRows = document.querySelectorAll('[data-testid="channel-row"]').length;
      out.ui.feed = Boolean(document.querySelector('[data-testid="message-feed"]'));
      out.ui.composer = Boolean(document.querySelector('[data-testid="composer-input"]'));
      out.ui.memberRail = Boolean(document.querySelector('[data-testid="member-rail"]'));

      /*
       * Send one real message through the composer. This is the whole write path: optimistic row,
       * POST /api/channels/:id/messages, the server's row, then the feed.
       */
      const composer = document.querySelector('[data-testid="composer-input"]');
      const send = document.querySelector('[data-testid="composer-send"]');
      if (composer && send) {
        const setText = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setText.call(composer, 'Smoke message from the real backend');
        composer.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 100));
        send.click();

        out.ui.sentMessage = await waitFor(
          () => document.querySelectorAll('[data-testid="message-row"]').length > 0,
          6000,
        );
      }
      out.ui.messageRows = document.querySelectorAll('[data-testid="message-row"]').length;
    }
  }

  /*
   * Voice channels render a stage, not a composer. Joining would raise a microphone prompt that a
   * headless smoke run cannot answer, so this proves the route and the affordance, not capture.
   */
  const voiceRows = Array.from(document.querySelectorAll('[data-testid="channel-row"]')).filter(
    (row) => row.getAttribute('data-kind') === 'voice'
  );
  out.ui.voiceChannels = voiceRows.length;

  if (voiceRows[0]) {
    voiceRows[0].click();
    out.ui.voiceStage =
      (await waitFor(() => document.querySelector('[data-testid="voice-stage"]'), 2000)) &&
      Boolean(document.querySelector('[data-testid="join-voice"]'));
    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  /*
   * Join with Chromium's fake microphone. This is the whole call path in the real app: permission
   * policy, getUserMedia, the analyser, the control bar and leaving again.
   */
  const joinVoice = document.querySelector('[data-testid="join-voice"]');
  if (joinVoice) {
    joinVoice.click();
    out.ui.voiceConnected = await waitFor(
      () => document.querySelector('[data-testid="voice-controls"]'),
      5000
    );

    const camera = document.querySelector(
      '[data-testid="voice-controls"] [aria-label="Turn camera on"]'
    );
    if (camera) {
      camera.click();
      out.ui.voiceCamera = await waitFor(
        () => document.querySelector('video[aria-label="Your camera"]'),
        4000
      );
      const cameraOff = document.querySelector(
        '[data-testid="voice-controls"] [aria-label="Turn camera off"]'
      );
      if (cameraOff) {
        cameraOff.click();
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }

    const mute = document.querySelector(
      '[data-testid="voice-controls"] [aria-label="Mute microphone"]'
    );
    if (mute) {
      mute.click();
      await new Promise((resolve) => setTimeout(resolve, 100));
      out.ui.voiceMuted = Boolean(
        document.querySelector('[data-testid="voice-controls"] [aria-label="Unmute microphone"]')
      );
    }

    const leave = document.querySelector('[data-testid="leave-voice"]');
    if (leave) {
      leave.click();
      await new Promise((resolve) => setTimeout(resolve, 150));
      out.ui.voiceLeft = !document.querySelector('[data-testid="voice-controls"]');
    }
  }

  /* Settings: open, walk three sections, close. Nothing here mutates the saved profile. */
  const settingsButton = document.querySelector('[data-testid="open-settings"]');
  if (settingsButton) {
    settingsButton.click();
    out.ui.settingsModal = await waitFor(
      () => document.querySelector('[data-testid="settings-modal"]'),
      2000
    );
    out.ui.settingsProfile = Boolean(document.querySelector('[data-testid="profile-preview"]'));

    const nameInput = document.querySelector('[data-testid="display-name-input"]');
    if (nameInput) {
      const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setInputValue.call(nameInput, 'Smoke User');
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 150));

      const selfButton = document.querySelector('[data-testid="open-settings"]');
      out.ui.displayNameUpdated = Boolean(
        selfButton && selfButton.textContent && selfButton.textContent.includes('Smoke User')
      );

      try {
        const stored = JSON.parse(localStorage.getItem('aegis.settings.v1'));
        out.ui.settingsPersisted = stored && stored.profile.displayName === 'Smoke User';
      } catch (error) {
        out.ui.settingsPersisted = false;
      }
    }

    const statusTab = document.querySelector('[data-testid="settings-tab-status"]');
    if (statusTab) {
      statusTab.click();
      await new Promise((resolve) => setTimeout(resolve, 80));
      out.ui.settingsStatus = Boolean(document.querySelector('[data-testid="status-preview"]'));
    }

    const voiceTab = document.querySelector('[data-testid="settings-tab-voice"]');
    if (voiceTab) {
      voiceTab.click();
      await new Promise((resolve) => setTimeout(resolve, 120));
      out.ui.settingsVoice = Boolean(document.querySelector('[data-testid="mic-test"]'));
    }

    const closeSettings = document.querySelector(
      '[data-testid="settings-modal"] [aria-label="Close settings"]'
    );
    if (closeSettings) closeSettings.click();
    await new Promise((resolve) => setTimeout(resolve, 120));
    out.ui.settingsClosed = !document.querySelector('[data-testid="settings-modal"]');
  }

  /* Server settings: rename/role management share one persisted write. */
  const serverButton = document.querySelector('[data-testid="open-server-settings"]');
  if (serverButton) {
    serverButton.click();
    out.ui.serverSettings = await waitFor(
      () => document.querySelector('[data-testid="server-settings-modal"]'),
      2000
    );

    const rolesTab = document.querySelector('[data-testid="server-tab-roles"]');
    if (rolesTab) {
      rolesTab.click();
      await new Promise((resolve) => setTimeout(resolve, 120));
      out.ui.roleRows = document.querySelectorAll('[data-testid="role-row"]').length;
    }

    // The overview's description field is the other half of server identity.
    const overviewTab = document.querySelector('[data-testid="server-tab-overview"]');
    if (overviewTab) {
      overviewTab.click();
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    out.ui.serverDescription = Boolean(document.querySelector('[data-testid="server-description"]'));
    out.ui.serverIconUpload = Boolean(document.querySelector('[data-testid="server-icon-upload"]'));

    /*
     * Notifications: choose "Nothing", then prove two things - the overlay recorded it, and the
     * rail actually stopped reporting activity. Restoring "All messages" keeps later checks clean.
     */
    const notifyTab = document.querySelector('[data-testid="server-tab-notifications"]');
    if (notifyTab) {
      notifyTab.click();
      await new Promise((resolve) => setTimeout(resolve, 120));
      out.ui.serverNotifications =
        Boolean(document.querySelector('[data-testid="server-notify-options"]')) &&
        Boolean(document.querySelector('[data-testid="server-system-channel"]'));

      const none = document.querySelector('[data-testid="server-notify-none"]');
      if (none) {
        none.click();
        await new Promise((resolve) => setTimeout(resolve, 160));

        /*
         * Persistence is a server fact now, so ask the server. Poll briefly: the click applies
         * optimistically and the PATCH is a real round trip.
         */
        out.ui.serverNotifyPersisted = false;
        for (let attempt = 0; attempt < 20 && !out.ui.serverNotifyPersisted; attempt += 1) {
          try {
            const response = await fetch('http://127.0.0.1:8787/api/workspace', {
              headers: { 'x-aegis-user': 'nyx' },
            });
            const payload = await response.json();
            out.ui.serverNotifyPersisted = Boolean(
              payload &&
                payload.workspace &&
                Array.isArray(payload.workspace.guilds) &&
                payload.workspace.guilds.some(
                  (guild) => guild.name === 'Smoke Guild' && guild.notificationLevel === 'none',
                ),
            );
          } catch (error) {
            out.ui.serverNotifyPersisted = false;
          }

          if (!out.ui.serverNotifyPersisted) {
            await new Promise((resolve) => setTimeout(resolve, 150));
          }
        }

        out.ui.serverMutedRail = Boolean(
          document.querySelector('[data-testid="guild-rail"] [data-muted="true"]'),
        );

        const all = document.querySelector('[data-testid="server-notify-all"]');
        if (all) {
          all.click();
          await new Promise((resolve) => setTimeout(resolve, 120));
        }
      }
    }

    const closeServer = document.querySelector(
      '[data-testid="server-settings-modal"] [aria-label="Close server settings"]'
    );
    if (closeServer) closeServer.click();
    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  /* The member rail opens a profile card, including banner/bio/roles. */
  const memberRow = document.querySelector('[data-testid="member-row"]');
  if (memberRow) {
    memberRow.click();
    out.ui.profileCard = await waitFor(
      () => document.querySelector('[data-testid="profile-card"]'),
      2000
    );

    const closeProfile = document.querySelector('[data-testid="profile-card"] [aria-label="Close profile"]');
    if (closeProfile) closeProfile.click();
    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  out.ui.inlineStylesAfterAll = document.querySelectorAll('[style]').length;

  // The smoke run must not leave test settings in the real profile. Server state lives in the
  // backend's memory store and dies with the process.
  try {
    localStorage.removeItem('aegis.settings.v1');
  } catch (error) {
    /* storage may be unavailable; the run already proved what it needed */
  }

  return out;
})();`;

const EXPECTED_METHODS = [
  "files:openImageDialog",
  "files:revealInFolder",
  "files:saveExport",
  "subscribe",
];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runSmokeTest(win: BrowserWindow): Promise<void> {
  const report: Record<string, unknown> = { ok: false, electron: process.versions.electron };
  let code = 1;

  try {
    if (win.webContents.isLoading()) {
      // Bounded: after the seeding reload `isLoading` can stay true for a late subresource, and a
      // `did-finish-load` that already fired would otherwise wait forever.
      await Promise.race([
        new Promise<void>((resolve) => win.webContents.once("did-finish-load", () => resolve())),
        delay(5_000),
      ]);
    }

    console.log("[aegis-smoke] assertions starting");

    /*
     * Start the script, then push focus while its subscription is live. `executeJavaScript` awaits
     * a returned promise, so the explicit push has to happen before that await - the push from the
     * initial `did-finish-load` was already spent by the session seeding reload.
     */
    const setup = win.webContents.executeJavaScript(SETUP, true);
    await delay(250);
    win.webContents.send(Push.focusChanged, { focused: true });
    await setup;

    const result = (await Promise.race([
      win.webContents.executeJavaScript("window.__aegisSmoke", true) as Promise<
        Record<string, unknown>
      >,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("the renderer smoke script did not finish within 120 s")),
          120_000,
        ),
      ),
    ])) as Record<string, unknown>;
    console.log("[aegis-smoke] result received");
    const methods = Array.isArray(result.methods) ? result.methods : [];
    const sameMethods =
      methods.length === EXPECTED_METHODS.length && EXPECTED_METHODS.every((name) => methods.includes(name));

    const ui = (result.ui ?? {}) as Record<string, unknown>;

    const checks = {
      bridgeExposed: result.hasBridge === true,
      bridgeFrozen: result.frozen === true,
      exactlyThreeHandlersPlusSubscribe: sameMethods,
      noNodeInRenderer: result.nodeRequire === "undefined",
      pushDeliveredAndValidated: result.push === "delivered",
      badRequestRejected: result.badInputRejected === true,
      validCallRoundTripped: result.validCall === "ok",
      // The shell, not just the bridge: a blank window still passes every check above.
      shellRendered: ui.rail === true && ui.feed === true && ui.composer === true,
      // A fresh account must show the empty state, not an invented server.
      emptyWorkspaceRendered: ui.emptyState === true,
      channelListPopulated: typeof ui.channelRows === "number" && ui.channelRows > 0,
      feedHasRows: typeof ui.messageRows === "number" && ui.messageRows > 0,
      messageSendRoundTripped: ui.sentMessage === true,
      memberRailRendered: ui.memberRail === true,
      // The add-server button, and the server it creates actually existing in the rail.
      addServerAffordance: ui.addServerButton === true,
      serverCreatedInRail: ui.createdServer === true,
      createdServerOpensGeneral: ui.createdChannelIsGeneral === true,
      createdServerHasNoBacklog: ui.createdRows === 0,
      createDialogCloses: ui.modalClosed === true,
      voiceChannelPresent: typeof ui.voiceChannels === "number" && ui.voiceChannels > 0,
      voiceStageOpens: ui.voiceStage === true,
      voiceCallConnects: ui.voiceConnected === true,
      voiceMuteWorks: ui.voiceMuted === true,
      voiceCameraStreams: ui.voiceCamera === true,
      voiceCallLeaves: ui.voiceLeft === true,
      settingsDialogOpens: ui.settingsModal === true && ui.settingsProfile === true,
      settingsSectionsRender: ui.settingsStatus === true && ui.settingsVoice === true,
      displayNamePropagates: ui.displayNameUpdated === true,
      displayNamePersists: ui.settingsPersisted === true,
      settingsDialogCloses: ui.settingsClosed === true,
      serverSettingsRoles: ui.serverSettings === true && Number(ui.roleRows) > 0,
      serverSettingsIdentity:
        ui.serverDescription === true &&
        ui.serverIconUpload === true &&
        ui.serverNotifications === true,
      serverMuteApplies: ui.serverNotifyPersisted === true && ui.serverMutedRail === true,
      profileCardOpens: ui.profileCard === true,
      // The strict CSP forbids inline styles; the modal is the most tempting place to emit one.
      noInlineStyles: ui.inlineStyles === 0 && ui.inlineStylesAfterModal === 0,
      noInlineStylesAfterSettings: ui.inlineStylesAfterAll === 0,
    };

    Object.assign(report, { checks, result });
    report.ok = Object.values(checks).every(Boolean);
    code = report.ok ? 0 : 1;
  } catch (error) {
    report.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }

  try {
    writeFileSync(join(app.getPath("temp"), "aegis-smoke.json"), JSON.stringify(report, null, 2), "utf8");
  } catch {
    /* a failed report write must not mask the result above */
  }

  console.log(`[aegis-smoke] ${JSON.stringify(report)}`);
  app.exit(code);
}
