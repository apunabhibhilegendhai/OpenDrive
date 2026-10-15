-- Make the two ownership composite keys deferrable, so a whole tree can change owner atomically.
--
-- Builds on 20261014000001_anonymous_session_migration.sql. Additive: no column, row, policy or
-- index changes, and both constraints keep their exact definition — same columns, same referenced
-- columns, same `on delete restrict`. The only difference is *when* they are checked.
--
-- Why this is needed, in one sentence: moving an anonymous session's resources into an account
-- changes `owner_key` on folders and files at the same time, and both foreign keys are immediate,
-- so *every* possible ordering of that work is invalid at the moment it happens.
--
-- The two keys are:
--
--   files.files_folder_same_owner   (folder_id, owner_key) -> folders(id, owner_key)
--   folders.folders_parent_same_owner (parent_id, owner_key) -> folders(id, owner_key)
--
-- Moving a folder first leaves every file inside it referencing a parent key that no longer exists
-- (the file still carries the session's owner key while the folder carries the account's). Moving
-- the files first leaves them referencing a folder that still carries the session's key. There is no
-- order that works, and this was not a theoretical concern: the folder-first statement was run
-- against the live self-hosted instance and refused by `files_folder_same_owner`, exactly as
-- predicted here.
--
-- Doing it as one data-modifying statement (a writable CTE per table) can appear to work — it did,
-- once — but PostgreSQL specifies no order for data-modifying CTEs, so a run that passes is a
-- coincidence rather than a guarantee, and a referential integrity rule that depends on one is not
-- one. Deferral removes the question: the checks happen at COMMIT, against the finished state.
--
-- `deferrable initially immediate` is the relational answer: the checks still run at the end of each
-- statement for every other code path in this application (nothing changes for inserts, moves,
-- renames or deletes), and only a transaction that explicitly asks for it — the migration transfer,
-- which runs `set constraints files_folder_same_owner, folders_parent_same_owner deferred` inside
-- its own `sql.begin` — gets its checks at COMMIT, where the finished state is what is checked.
--
-- Cost: one validation scan per constraint at migration time (the definition is identical, so the
-- existing rows pass). Benefit: the transfer's atomicity is enforced by the database at commit
-- instead of depending on the order in which PostgreSQL happens to execute update sub-statements.
--
-- Verification status: applied to the self-hosted instance as
-- `105-opendrive-defer-ownership-constraints.sql`, then exercised by
-- supabase/tests/live/70_anonymous_migration_live.sql, which performs a full transfer (parent and
-- child folders, durable files inside them, an unfinished upload, a soft-deleted file and a
-- soft-deleted folder) and asserts the resulting ownership — all inside a block that rolls back.

alter table files
  drop constraint files_folder_same_owner;

alter table files
  add constraint files_folder_same_owner
    foreign key (folder_id, owner_key)
    references folders (id, owner_key)
    on delete restrict
    deferrable initially immediate;

alter table folders
  drop constraint folders_parent_same_owner;

alter table folders
  add constraint folders_parent_same_owner
    foreign key (parent_id, owner_key)
    references folders (id, owner_key)
    on delete restrict
    deferrable initially immediate;

comment on constraint files_folder_same_owner on files is
  'A file may sit only in a folder its own principal owns. Deferred-capable so a whole tree can change owner in one transaction; still checked at the end of each statement by default (initially immediate).';
comment on constraint folders_parent_same_owner on folders is
  'A child folder must have the same owner as its parent. Deferred-capable so a whole tree can change owner in one transaction; still checked at the end of each statement by default (initially immediate).';
