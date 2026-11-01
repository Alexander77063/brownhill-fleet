import { describe, expect, it } from 'vitest';
import { csvCell, csvRow } from '@/lib/csv';

/**
 * A CSV cell has two jobs: not to break the row it sits in, and not to be
 * something a spreadsheet runs. The second is the one people forget — quoting
 * does not save you, because a quoted cell whose content starts with `=` is
 * still evaluated.
 */
describe('a cell that would break the row', () => {
  it('quotes a cell holding a comma', () => {
    expect(csvCell('Brownhill, Ltd')).toBe('"Brownhill, Ltd"');
  });

  it('doubles the quotes inside a quoted cell', () => {
    expect(csvCell('Brownhill, "Ltd"')).toBe('"Brownhill, ""Ltd"""');
  });

  it('quotes a cell holding a newline', () => {
    expect(csvCell('one\ntwo')).toBe('"one\ntwo"');
  });

  it('quotes a cell holding a carriage return', () => {
    expect(csvCell('one\rtwo')).toBe('"one\rtwo"');
  });

  it('leaves an ordinary cell alone', () => {
    expect(csvCell('Samuel Okonkwo')).toBe('Samuel Okonkwo');
    expect(csvCell('')).toBe('');
  });
});

describe('a cell a spreadsheet would run', () => {
  it('neutralises a cell that starts with =', () => {
    expect(csvCell('=1+1')).toBe("'=1+1");
  });

  it('neutralises a cell that starts with +', () => {
    expect(csvCell('+1+1')).toBe("'+1+1");
  });

  it('neutralises a cell that starts with @', () => {
    expect(csvCell('@SUM(A1:A9)')).toBe("'@SUM(A1:A9)");
  });

  it('neutralises a formula that hides behind a leading space', () => {
    expect(csvCell('  =cmd')).toBe("'  =cmd");
  });

  it('neutralises a formula that hides behind a leading tab', () => {
    expect(csvCell('\t=cmd')).toBe("'\t=cmd");
  });

  it('quotes the neutralised cell when it also holds a comma', () => {
    expect(csvCell('=HYPERLINK("http://x","y")')).toBe(
      '"\'=HYPERLINK(""http://x"",""y"")"',
    );
  });
});

describe('a cell that is a number', () => {
  /**
   * The trap in the fix. A negative figure starts with a minus, so a rule that
   * neutralises every leading `-` turns the finance team's numbers into text —
   * and the column stops summing.
   */
  it('leaves a negative amount of money as it is', () => {
    expect(csvCell('-£556.00')).toBe('-£556.00');
    expect(csvCell('-£12,345.00')).toBe('"-£12,345.00"');
  });

  it('leaves a negative plain number as it is', () => {
    expect(csvCell('-1,234')).toBe('"-1,234"');
    expect(csvCell('-1234')).toBe('-1234');
    expect(csvCell('-12.34%')).toBe('-12.34%');
  });

  it('leaves an ordinary number as it is', () => {
    expect(csvCell('1,234')).toBe('"1,234"');
    expect(csvCell('12.34%')).toBe('12.34%');
    expect(csvCell('£1,234.56')).toBe('"£1,234.56"');
  });

  it('still neutralises a negative that is really an expression', () => {
    expect(csvCell('-1+1')).toBe("'-1+1");
    expect(csvCell('-2*3')).toBe("'-2*3");
  });
});

describe('a row', () => {
  it('joins the cells with commas', () => {
    expect(csvRow(['a', 'b,c'])).toBe('a,"b,c"');
  });
});
