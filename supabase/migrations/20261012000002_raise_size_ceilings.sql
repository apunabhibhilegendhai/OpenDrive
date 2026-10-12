-- Raise the single-file ceiling from 2 GiB to 5 GiB, and let an upload session carry a part up to
-- the Local Bot API server's 2,000,000,000-byte upload ceiling.
--
-- Why: the multipart uploader now sizes a part at up to 2,000,000,000 bytes (the `--local` Bot API
-- server limit), so an object larger than one part -- a 4 GB object is two parts -- has to be
-- representable end to end. The old 2 GiB ceiling lived in five places and all five must move
-- together, or an upload the API accepts is refused by the database halfway through:
--
--   files.size_bytes                     (files_size_bytes_check)
--   upload_sessions.declared_size_bytes  (upload_sessions_declared_size_bytes_check)
--   upload_sessions.chunk_size_bytes     (upload_sessions_chunk_size_bytes_check)
--   quota_limits.max_file_size_bytes     (quota_limits_max_file_size_bytes_check)
--   profiles.max_file_size_bytes         (the column default)
--
-- What is deliberately *not* widened: the anonymous policy. Its 256 MiB storage quota is an abuse
-- control, not a size limit, so it stays as it was (see docs/DECISIONS.md D38).

-- files: the persisted size of one object.
alter table files drop constraint files_size_bytes_check;
alter table files add constraint files_size_bytes_check
  check (size_bytes > 0 and size_bytes <= 5368709120);

-- upload_sessions: the declared object size and the part size a client may be asked for. The part
-- ceiling is the Local Bot API server's documented 2000 MB upload limit; the column is `integer`
-- (max 2,147,483,647), which still holds 2,000,000,000.
alter table upload_sessions drop constraint upload_sessions_declared_size_bytes_check;
alter table upload_sessions add constraint upload_sessions_declared_size_bytes_check
  check (declared_size_bytes > 0 and declared_size_bytes <= 5368709120);

alter table upload_sessions drop constraint upload_sessions_chunk_size_bytes_check;
alter table upload_sessions add constraint upload_sessions_chunk_size_bytes_check
  check (chunk_size_bytes between 1048576 and 2000000000);

-- The policy table: widen the check, then the value.
alter table quota_limits drop constraint quota_limits_max_file_size_bytes_check;
alter table quota_limits add constraint quota_limits_max_file_size_bytes_check
  check (max_file_size_bytes > 0 and max_file_size_bytes <= 5368709120);

update quota_limits
   set max_file_size_bytes = 5368709120,
       updated_at = now()
 where principal_kind = 'user';

-- A registered user's *effective* limit is read from their profile row (opendrive_reserve_storage),
-- not from quota_limits, so the default and every existing row must move with it. The 5 GiB value
-- matches the profile storage quota, so a single 5 GiB file fits exactly.
alter table profiles alter column max_file_size_bytes set default 5368709120;
update profiles
   set max_file_size_bytes = 5368709120,
       updated_at = now()
 where max_file_size_bytes < 5368709120;
