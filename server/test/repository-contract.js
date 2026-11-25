import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Behaviour every repository backend must share. Run against memory always,
 * and against Postgres when DATABASE_TEST_URL is set (see postgres.test.js).
 *
 * @param {string} name - backend label for test names
 * @param {() => Promise<object>} makeRepo - returns a fresh, empty repository
 *   (no seed), already migrated if the backend needs it
 */
export function runRepositoryContract(name, makeRepo) {
  const t = (title, fn) => test(`[${name}] ${title}`, fn);

  async function setup() {
    const repo = await makeRepo();
    const a = (await repo.createUser())._id;
    const b = (await repo.createUser())._id;
    return { repo, a, b, A: repo.forUser(a), B: repo.forUser(b) };
  }

  t('symptoms upsert one entry per day and stay per-patient', async () => {
    const { A, B } = await setup();
    const day = '2026-11-20T09:00:00Z';
    await A.upsertSymptomEntry({ date: day, items: { fatigue: 5 }, total: 5, note: 'x' });
    const second = await A.upsertSymptomEntry({
      date: '2026-11-20T18:00:00Z',
      items: { fatigue: 7 },
      total: 7,
      weightKg: 70.5,
    });
    assert.equal(second.total, 7);
    assert.equal(second.weightKg, 70.5);
    await A.upsertSymptomEntry({ date: '2026-11-21T09:00:00Z', items: {}, total: 1 });

    const list = await A.listSymptoms();
    assert.equal(list.length, 2);
    assert.ok(new Date(list[0].date) > new Date(list[1].date), 'newest first');
    const ranged = await A.listSymptoms({ from: '2026-11-21T00:00:00Z' });
    assert.equal(ranged.length, 1);
    assert.equal((await B.listSymptoms()).length, 0);
  });

  t('lab upserts dedupe by externalId per patient', async () => {
    const { A, B } = await setup();
    const lab = (value, externalId) => ({
      analyte: 'hemoglobin',
      loinc: '718-7',
      value,
      unit: 'g/dL',
      refLow: 13.5,
      refHigh: 17.5,
      flag: 'low',
      collectedAt: new Date('2026-11-01T10:00:00Z'),
      source: 'msk',
      provenance: { system: 'epic-fhir-r4', externalId },
    });
    await A.upsertLabResults([lab(9.1, 'Observation/1'), lab(9.4, 'Observation/2')]);
    await A.upsertLabResults([lab(9.9, 'Observation/1')]); // re-sync, updated value
    await A.upsertLabResults([{ ...lab(10, undefined), provenance: undefined }]);
    // Same upstream id for another patient is a different row.
    await B.upsertLabResults([lab(12, 'Observation/1')]);

    const labs = await A.listLabs({ analyte: 'hemoglobin' });
    assert.equal(labs.length, 3);
    assert.ok(labs.some((l) => l.value === 9.9));
    assert.ok(!labs.some((l) => l.value === 9.1));
    assert.deepEqual(await A.listAnalytes(), ['hemoglobin']);
    assert.equal((await A.listLabs({ source: 'capital-health' })).length, 0);
    assert.equal((await B.listLabs()).length, 1);
  });

  t('medications sync idempotently and doses need an owned medication', async () => {
    const { A, B } = await setup();
    const med = {
      name: 'Ruxolitinib 20 mg',
      dose: '20 mg BID',
      schedule: { times: ['08:00', '20:00'] },
      active: true,
      source: 'msk',
      provenance: { system: 'epic-fhir-r4', externalId: 'MedicationRequest/9' },
    };
    await A.upsertMedications([med]);
    await A.upsertMedications([{ ...med, dose: '15 mg BID' }]);
    const meds = await A.listMedications();
    assert.equal(meds.length, 1);
    assert.equal(meds[0].dose, '15 mg BID');

    const dose = await A.logDose(meds[0]._id, { status: 'taken' });
    assert.equal(dose.status, 'taken');
    assert.ok(dose.takenAt);
    const skipped = await A.logDose(meds[0]._id, { status: 'skipped' });
    assert.equal(skipped.takenAt, null);
    assert.equal((await A.listDoseLogs()).length, 2);

    assert.equal(await B.logDose(meds[0]._id, { status: 'taken' }), null);
    assert.equal((await B.listDoseLogs()).length, 0);
  });

  t('pallor photos are per-patient, including lookup by id', async () => {
    const { A, B } = await setup();
    const p = await A.addPallorPhoto({
      pallorScore: 0.4,
      storage: { key: 'u/a/1', sha256: 'abc', contentType: 'image/jpeg' },
    });
    assert.equal(p.eye, 'right');
    assert.equal((await A.getPallorPhoto(p._id)).storage.key, 'u/a/1');
    assert.equal(await B.getPallorPhoto(p._id), null);
    assert.equal((await B.listPallor()).length, 0);
  });

  t('integration connections patch, touch and report status', async () => {
    const { A, B } = await setup();
    assert.equal(await A.touchIntegrationSync('msk'), null);
    await A.updateConnection('msk', {
      system: 'epic-fhir-r4',
      status: 'disconnected',
      pendingAuth: { state: 's', codeVerifier: 'v' },
    });
    await A.updateConnection('msk', {
      status: 'connected',
      tokens: { accessTokenEnc: 'enc' },
      pendingAuth: null,
    });
    const conn = await A.getConnection('msk');
    assert.equal(conn.status, 'connected');
    assert.equal(conn.pendingAuth, null);
    assert.equal(conn.tokens.accessTokenEnc, 'enc');
    const touched = await A.touchIntegrationSync('msk');
    assert.ok(touched.lastSyncAt);
    assert.equal((await A.integrationsStatus()).length, 1);
    assert.equal(await B.getConnection('msk'), null);
  });

  t('export omits tokens; erasure clears only that patient', async () => {
    const { A, B } = await setup();
    await A.upsertSymptomEntry({ items: {}, total: 3 });
    await A.updateConnection('msk', {
      status: 'connected',
      tokens: { accessTokenEnc: 'x' },
    });
    await B.upsertSymptomEntry({ items: {}, total: 4 });

    const exported = await A.exportData();
    assert.equal(exported.symptoms.length, 1);
    assert.equal(exported.integrations.length, 1);
    assert.equal(exported.integrations[0].tokens, undefined);

    const counts = await A.deleteAllData();
    assert.equal(counts.symptoms, 1);
    assert.equal(counts.integrations, 1);
    assert.equal((await A.listSymptoms()).length, 0);
    assert.equal((await B.listSymptoms()).length, 1);
  });

  t('passkeys map back to their user; challenges are single-use', async () => {
    const { repo, a, b } = await setup();
    await repo.addCredential(a, {
      id: 'cred-a',
      publicKey: 'pk',
      counter: 0,
      transports: ['internal'],
    });
    assert.equal((await repo.getCredential('cred-a')).userId, a);
    await repo.updateCredentialCounter('cred-a', 5);
    assert.equal((await repo.getCredential('cred-a')).counter, 5);
    assert.equal((await repo.listCredentials(a)).length, 1);
    assert.equal((await repo.listCredentials(b)).length, 0);
    assert.equal(await repo.getCredential('nope'), null);

    await repo.saveChallenge('ch-1', { purpose: 'registration', userId: a });
    assert.equal(await repo.consumeChallenge('ch-1', 'authentication'), null);
    await repo.saveChallenge('ch-2', { purpose: 'registration', userId: a });
    assert.deepEqual(await repo.consumeChallenge('ch-2', 'registration'), {
      purpose: 'registration',
      userId: a,
    });
    assert.equal(await repo.consumeChallenge('ch-2', 'registration'), null);
  });

  t('password logins: one per user, unique email, removed with the user', async () => {
    const { repo, a, b } = await setup();
    const email = `pw-${a}@example.com`;
    await repo.setPasswordLogin(a, { email, passwordHash: 'h1' });
    assert.deepEqual(await repo.getPasswordLogin(email), {
      userId: a,
      email,
      passwordHash: 'h1',
    });
    // Replacing keeps one login per user.
    await repo.setPasswordLogin(a, { email, passwordHash: 'h2' });
    assert.equal((await repo.getPasswordLoginForUser(a)).passwordHash, 'h2');
    assert.equal(await repo.getPasswordLoginForUser(b), null);
    assert.ok((await repo.countPasswordLogins()) >= 1);

    await assert.rejects(
      async () => repo.setPasswordLogin(b, { email, passwordHash: 'h3' }),
      (err) => err.code === 'EMAIL_TAKEN',
    );
    assert.equal(await repo.getPasswordLogin('nobody@example.com'), null);

    await repo.deleteUser(a);
    assert.equal(await repo.getPasswordLogin(email), null);
  });

  t('medications: create, update, stop, scoped per patient', async () => {
    const { A, B } = await setup();
    const med = await A.createMedication({
      name: 'Examplamab',
      dose: '10 mg',
      schedule: { times: ['08:00'] },
      prescriber: { name: 'Dr. Example' },
      source: 'self',
      provenance: { system: 'manual' },
    });
    assert.ok(med._id);
    assert.equal(med.active, true);
    assert.equal(await B.updateMedication(med._id, { dose: 'x' }), null);

    assert.equal(med.trial ?? null, null);
    const marked = await A.updateMedication(med._id, {
      trial: { name: 'Study X', cycleDays: 21 },
    });
    assert.deepEqual(marked.trial, { name: 'Study X', cycleDays: 21 });
    const edited = await A.updateMedication(med._id, { dose: '20 mg' });
    assert.deepEqual(edited.trial, { name: 'Study X', cycleDays: 21 });
    assert.equal(edited.dose, '20 mg');
    assert.equal(edited.name, 'Examplamab');
    assert.equal(edited.prescriber.name, 'Dr. Example');

    await A.updateMedication(med._id, { active: false, stoppedAt: new Date() });
    assert.equal((await A.listMedications()).length, 0);
    assert.equal(await A.updateMedication('missing', { dose: '1' }), null);
  });

  t(
    'dose diary: one record per scheduled dose, with amount; window + clear',
    async () => {
      const { A, B } = await setup();
      const med = await A.createMedication({
        name: 'Examplinib',
        schedule: { times: ['08:00'] },
      });
      const slot = '2026-03-02T13:00:00.000Z';
      const first = await A.upsertDose(med._id, {
        scheduledFor: slot,
        status: 'taken',
        takenAt: '2026-03-02T13:20:00.000Z',
        amount: { tablets: 3, mg: 15 },
      });
      assert.deepEqual(first.amount, { tablets: 3, mg: 15 });
      // Same slot again replaces, not duplicates.
      await A.upsertDose(med._id, {
        scheduledFor: slot,
        status: 'skipped',
        amount: null,
      });
      let doses = await A.listDoseLogs();
      assert.equal(doses.length, 1);
      assert.equal(doses[0].status, 'skipped');
      assert.equal(doses[0].takenAt, null);
      // Other patients can't log against this medication.
      assert.equal(await B.upsertDose(med._id, { scheduledFor: slot }), null);

      await A.upsertDose(med._id, {
        scheduledFor: '2026-03-05T13:00:00.000Z',
        status: 'taken',
      });
      doses = await A.listDoseLogs({ from: '2026-03-03T00:00:00.000Z' });
      assert.equal(doses.length, 1);
      assert.equal(await A.clearDose(med._id, slot), true);
      assert.equal(await A.clearDose(med._id, slot), false);
      assert.equal((await A.listDoseLogs()).length, 1);
    },
  );

  t('history includes stopped medications with timestamps', async () => {
    const { A } = await setup();
    const med = await A.createMedication({ name: 'Oldmed', schedule: {} });
    await A.updateMedication(med._id, { active: false, stoppedAt: new Date() });
    const all = await A.listAllMedications();
    assert.equal(all.length, 1);
    assert.equal(all[0].active, false);
    assert.ok(all[0].createdAt && all[0].updatedAt);
  });

  t('visit reports: newest first, per patient, erased with the data', async () => {
    const { A, B } = await setup();
    await A.createReport({
      periodStart: new Date('2026-01-01'),
      periodEnd: new Date('2026-01-15'),
      recipients: [{ name: 'Dr. Example', email: 'dr@example.org' }],
      summary: { doses: 10 },
    });
    await A.createReport({
      periodStart: new Date('2026-01-15'),
      periodEnd: new Date('2026-02-01'),
    });
    const reports = await A.listReports();
    assert.equal(reports.length, 2);
    assert.equal(
      new Date(reports[0].periodEnd).toISOString(),
      '2026-02-01T00:00:00.000Z',
    );
    assert.equal(reports[1].recipients[0].email, 'dr@example.org');
    assert.equal((await B.listReports()).length, 0);
    const counts = await A.deleteAllData();
    assert.equal(counts.visitReports, 2);
    assert.equal((await A.listReports()).length, 0);
  });

  t('audit log records entries per user', async () => {
    const { repo, a } = await setup();
    await repo.recordAudit({
      userId: a,
      actor: 'user',
      action: 'read',
      route: 'GET /api/v1/labs',
      status: 200,
      at: new Date(),
    });
    const entries = await repo.getAuditLog({ userId: a });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].route, 'GET /api/v1/labs');
  });

  t('deleting a user removes their passkeys and PHI', async () => {
    const { repo, a, A } = await setup();
    await repo.addCredential(a, { id: `cred-del-${a}`, publicKey: 'pk', counter: 0 });
    await A.upsertSymptomEntry({ items: {}, total: 1 });
    await repo.deleteUser(a);
    assert.equal(await repo.getUser(a), null);
    assert.equal(await repo.getCredential(`cred-del-${a}`), null);
    assert.equal((await repo.forUser(a).listSymptoms()).length, 0);
  });
}
