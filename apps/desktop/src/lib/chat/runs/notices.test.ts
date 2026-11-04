import assert from 'node:assert/strict';
import test from 'node:test';
import {
    userEditNotice,
    noticeBlock,
    previewText,
    userAskedMeanwhileNotice,
    workerChangesNotice,
    writeNotice,
} from './notices.ts';

test('W4: a long file preview names the lines left out', () => {
    const text = Array.from({ length: 45 }, (_, i) => `line ${i + 1}`).join(
        '\n',
    );
    const shown = previewText(text, 40);
    assert.ok(shown.includes('line 40'));
    assert.ok(!shown.includes('line 41'));
    assert.ok(shown.endsWith('… and 5 more line(s)'));
});

test("W5: the write notice names the file, the run and the user's request", () => {
    const notice = writeNotice({
        path: 'en.json',
        byLabel: 'listener',
        intent: 'ghi ngắn gọn',
        after: 'Áp dụng lọc',
    });
    assert.ok(
        notice.startsWith('[AgentDeck] A side run (listener) changed en.json'),
    );
    assert.ok(notice.includes('"ghi ngắn gọn"'));
    assert.ok(notice.includes('Áp dụng lọc'));
});

test("W5: a meanwhile message and a worker summary keep the user's words and the ledger paths", () => {
    assert.ok(userAskedMeanwhileNotice('  sửa nhãn  ').includes('"sửa nhãn"'));
    const summary = workerChangesNotice('Explore · Scan docs', [
        'a.ts',
        'b.ts',
    ]);
    assert.ok(summary.includes('- a.ts') && summary.includes('- b.ts'));
});

test('W4: no notices make an empty block; some end with a blank line', () => {
    assert.equal(noticeBlock([]), '');
    assert.equal(noticeBlock(['x']), 'x\n\n');
});

test("W5 trigger 6: a user edit says the user's text is the newest version", () => {
    const notice = userEditNotice({ path: 'en.json', after: 'nhãn mới' });
    assert.ok(notice.includes('The user edited en.json by hand'));
    assert.ok(notice.includes('nhãn mới'));
});
