import { describe, it, expect } from 'vitest';
import { statementShape } from './sql-statement-shape';

describe('statementShape', () => {
  it('one statement, with or without its closing semicolon', () => {
    expect(statementShape("UPDATE t SET v = 'x' WHERE id = 1")).toEqual({ several: false, hasUpdate: true });
    expect(statementShape("UPDATE t SET v = 'x' WHERE id = 1;  ")).toEqual({ several: false, hasUpdate: true });
  });

  it('two statements', () => {
    expect(statementShape('UPDATE a SET x = 1; DELETE FROM b').several).toBe(true);
  });

  // Measured on DEV: `'<?php echo 1; ?>'` read as a second statement.
  it('a semicolon inside a string literal is not a statement boundary', () => {
    expect(statementShape("UPDATE t SET v = '<?php echo 1; ?>' WHERE id = 3").several).toBe(false);
    expect(statementShape('UPDATE t SET v = "a; b" WHERE id = 3').several).toBe(false);
    expect(statementShape("UPDATE t SET v = 'it''s; fine' WHERE id = 3").several).toBe(false);
    expect(statementShape("UPDATE t SET v = 'back\\'slash; ok' WHERE id = 3").several).toBe(false);
  });

  it('a semicolon or UPDATE in a comment or quoted identifier is not code', () => {
    expect(statementShape('SELECT 1 -- one; two').several).toBe(false);
    expect(statementShape('SELECT 1 /* a; UPDATE b */')).toEqual({ several: false, hasUpdate: false });
    expect(statementShape('SELECT `a;b` FROM t').several).toBe(false);
  });

  it('finds an UPDATE only where a statement starts', () => {
    expect(statementShape("SELECT 'update x' FROM t").hasUpdate).toBe(false);
    expect(statementShape('SELECT 1; update t set a = 1').hasUpdate).toBe(true);
    expect(statementShape('CREATE TABLE t (id int)').hasUpdate).toBe(false);
  });
});
