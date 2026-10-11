import type { ReactNode } from 'react';

/**
 * A ledger row: a narrow left rail naming the section in plain sentence case, and the
 * content on the right. The rule between rows is structural — it separates records, it
 * is not decoration — so every section uses the same one.
 */
export function LedgerSection({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <section className="ledger">
      <div className="ledger__rail">
        <h2 className="ledger__title">{title}</h2>
        {note !== undefined && <p className="ledger__note">{note}</p>}
      </div>
      <div className="ledger__body">{children}</div>
    </section>
  );
}
