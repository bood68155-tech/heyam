'use strict';

/**
 * Offline self-check: exercises every piece of logic that does not need
 * network access or Google/Gemini credentials.
 *
 *   npm run check
 */

const assert = require('node:assert');

const {
  toAsciiDigits,
  normalizeArabic,
  normalizeKey,
  normalizePhone,
  formatPhone,
  maskPhone,
  looksLikeBulk,
  matchesQuery,
  escapeHtml,
} = require('../src/utils');
const {
  validateFullName,
  validateUniversityId,
  validateSection,
  validateMajor,
  validatePhone,
  validateRecord,
} = require('../src/validators');
const { heuristicParse } = require('../src/heuristic');
const messages = require('../src/messages');
const { parsePreviewRecord } = require('../src/flows/addStudent');

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✔ ${name}`);
  } catch (err) {
    failures.push({ name, message: err.message });
    console.log(`  ✘ ${name}\n      ${err.message}`);
  }
}

console.log('\n=== utils ===');
check('Arabic-Indic digits convert to ASCII', () => {
  assert.strictEqual(toAsciiDigits('١٢٣٤٥٦٧٨٩٠'), '1234567890');
  assert.strictEqual(toAsciiDigits('۲۰۲۳'), '2023');
});
check('Arabic spelling variants normalize', () => {
  assert.strictEqual(normalizeArabic('أحمد إبراهيم'), 'احمد ابراهيم');
  assert.strictEqual(normalizeArabic('مصطفى'), 'مصطفي');
  assert.strictEqual(normalizeArabic('فاطمة'), 'فاطمه');
  assert.strictEqual(normalizeKey('  محمد   أحمد  '), 'محمد احمد');
});
check('phone normalization applies the default country code', () => {
  assert.strictEqual(normalizePhone('0771234567', '967'), '967771234567');
  assert.strictEqual(normalizePhone('+967 77 123 4567', '967'), '967771234567');
  assert.strictEqual(normalizePhone('00967-771-234-567'), '967771234567');
  assert.strictEqual(normalizePhone('٠٧٧١٢٣٤٥٦٧', '967'), '967771234567');
  assert.strictEqual(normalizePhone('0771234567', ''), '0771234567');
});
check('phone display and masking never leak the full number in logs', () => {
  assert.strictEqual(formatPhone('967771234567'), '+967771234567');
  assert.strictEqual(maskPhone('967771234567').slice(-4), '4567');
  assert.ok(!maskPhone('967771234567').includes('7712'));
});
check('bulk input detection', () => {
  assert.strictEqual(looksLikeBulk('محمد أحمد علي الصالح'), false);
  assert.strictEqual(
    looksLikeBulk('الاسم: محمد أحمد علي الصالح\nالرقم الجامعي: 20231234\nالشعبة: عربي'),
    true,
  );
  assert.strictEqual(looksLikeBulk('20231234 عربي 0771234567 هندسة حاسوب محمد احمد علي'), true);
});
check('query matching by name fragment and university ID', () => {
  const record = { fullName: 'محمد أحمد علي الصالح', universityId: '20231234' };
  assert.strictEqual(matchesQuery(record, 'الصالح'), true);
  assert.strictEqual(matchesQuery(record, 'أحمد'), true);
  assert.strictEqual(matchesQuery(record, '2023'), true);
  assert.strictEqual(matchesQuery(record, 'احمد علي'), true);
  assert.strictEqual(matchesQuery(record, 'خالد'), false);
});
check('HTML escaping', () => {
  assert.strictEqual(escapeHtml('<b>&x</b>'), '&lt;b&gt;&amp;x&lt;/b&gt;');
});

console.log('\n=== validators ===');
check('four-part Arabic name accepted', () => {
  const result = validateFullName('محمد أحمد علي الصالح');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.value, 'محمد أحمد علي الصالح');
});
check('short name rejected with a helpful error', () => {
  const result = validateFullName('محمد أحمد');
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /رباع/);
});
check('compound names count as one name part', () => {
  assert.strictEqual(validateFullName('عبد الله محمد').ok, false); // 2 parts
  assert.strictEqual(validateFullName('محمد عبد الله علي').ok, false); // 3 parts
  assert.strictEqual(validateFullName('عبدالله محمد علي الصالح').ok, true); // 4 parts
  assert.strictEqual(validateFullName('محمد عبد الله علي الصالح').ok, true); // 4 parts
});
check('digits in a name are rejected', () => {
  assert.strictEqual(validateFullName('محمد احمد علي 2023').ok, false);
});
check('university ID normalization and validation', () => {
  assert.strictEqual(validateUniversityId('٢٠٢٣١٢٣٤').value, '20231234');
  assert.strictEqual(validateUniversityId(' 2023-1234 ').value, '20231234');
  assert.strictEqual(validateUniversityId('abc').ok, false);
  assert.strictEqual(validateUniversityId('12').ok, false);
  assert.strictEqual(validateUniversityId('1234567890123456').ok, false);
});
check('section spellings map to عربي / إنجليزي', () => {
  assert.strictEqual(validateSection('عربي').value, 'عربي');
  assert.strictEqual(validateSection('Arabic').value, 'عربي');
  assert.strictEqual(validateSection('english').value, 'إنجليزي');
  assert.strictEqual(validateSection('انجليزي').value, 'إنجليزي');
  assert.strictEqual(validateSection('FR').ok, false);
});
check('major validation', () => {
  assert.strictEqual(validateMajor('هندسة حاسوب').value, 'هندسة حاسوب');
  assert.strictEqual(validateMajor('  ').ok, false);
  assert.strictEqual(validateMajor('a').ok, false);
});
check('phone validation with country code', () => {
  assert.strictEqual(validatePhone('0771234567', '967').value, '967771234567');
  assert.strictEqual(validatePhone('123', '967').ok, false);
  assert.strictEqual(validatePhone('0771234567').value, '0771234567');
});
check('full record validation', () => {
  const result = validateRecord(
    {
      fullName: 'محمد أحمد علي الصالح',
      universityId: '20231234',
      section: 'arabic',
      major: 'هندسة حاسوب',
      phone: '0771234567',
    },
    { defaultCountryCode: '967' },
  );
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.data, {
    fullName: 'محمد أحمد علي الصالح',
    universityId: '20231234',
    section: 'عربي',
    major: 'هندسة حاسوب',
    phone: '967771234567',
  });
});
check('partial record reports every missing field', () => {
  const result = validateRecord({ fullName: 'محمد أحمد علي الصالح' });
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(Object.keys(result.errors).sort(), ['major', 'phone', 'section', 'universityId']);
});

console.log('\n=== offline parser (Gemini fallback) ===');
check('labelled block parses into all five fields', () => {
  const parsed = heuristicParse(
    [
      'بيانات الطالب',
      'الاسم: محمد أحمد علي الصالح',
      'الرقم الجامعي: 20231234',
      'الشعبة: عربي',
      'التخصص: هندسة حاسوب',
      'الهاتف: 0771234567',
    ].join('\n'),
  );
  assert.strictEqual(parsed.fullName, 'محمد أحمد علي الصالح');
  assert.strictEqual(parsed.universityId, '20231234');
  assert.strictEqual(parsed.section, 'عربي');
  assert.strictEqual(parsed.major, 'هندسة حاسوب');
  assert.strictEqual(parsed.phone, '0771234567');
});
check('English labels and "English" section parse', () => {
  const parsed = heuristicParse('Name: Sara Ali Hassan Omar\nID: 20240001\nSection: English\nMajor: Computer Science\nPhone: +967771234567');
  assert.strictEqual(parsed.fullName, 'Sara Ali Hassan Omar');
  assert.strictEqual(parsed.universityId, '20240001');
  assert.strictEqual(parsed.section, 'إنجليزي');
  assert.strictEqual(parsed.phone, '+967771234567');
});
check('unlabelled block still yields name, ID and phone', () => {
  const parsed = heuristicParse('محمد أحمد علي الصالح\n20231234\nهندسة حاسوب\n0771234567');
  assert.strictEqual(parsed.fullName, 'محمد أحمد علي الصالح');
  assert.strictEqual(parsed.universityId, '20231234');
  assert.strictEqual(parsed.phone, '0771234567');
});
check('garbage input produces no fields', () => {
  const parsed = heuristicParse('مرحبا');
  assert.deepStrictEqual(parsed, {});
});

console.log('\n=== serverless save recovery ===');
check('a confirmed preview rebuilds the exact record (session lost on another instance)', () => {
  const pending = {
    fullName: 'محمد أحمد علي الصالح',
    universityId: '20231234',
    section: 'عربي',
    major: 'هندسة حاسوب',
    phone: '967771234567',
  };
  const preview = messages.add.preview(pending, {
    aiUsed: true,
    changes: ['التخصص: تم توحيد المسمى'],
  });
  const recovered = parsePreviewRecord(preview);
  assert.deepStrictEqual(recovered, { ...pending, phone: '+967771234567' });
  assert.deepStrictEqual(validateRecord(recovered, { defaultCountryCode: '967' }).data, pending);
});
check('AI notes cannot overwrite fields, and plain questions are not previews', () => {
  const withNotes = messages.add.preview(
    {
      fullName: 'سارة علي حسن عمر',
      universityId: '20240001',
      section: 'إنجليزي',
      major: 'Computer Science',
      phone: '967771234567',
    },
    { changes: ['التخصص: تم توحيد المسمى إلى Computer Science'] },
  );
  assert.strictEqual(parsePreviewRecord(withNotes).major, 'Computer Science');
  assert.strictEqual(parsePreviewRecord(messages.add.ask.fullName), null);
});

console.log(`\n${failures.length === 0 ? '✅' : '❌'} ${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const failure of failures) console.log(` - ${failure.name}: ${failure.message}`);
  process.exit(1);
}
