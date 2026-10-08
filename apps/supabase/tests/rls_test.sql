begin;
select plan(3);

-- two fake users
insert into auth.users (id, instance_id, aud, role, email)
values ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a@test.com'),
       ('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b@test.com');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}';
select create_project('A project');

select is((select count(*) from projects), 1::bigint, 'creator sees own project');

set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated"}';
select is((select count(*) from projects), 0::bigint, 'outsider sees nothing');

select throws_ok(
  $$ insert into messages (project_id, body) values (gen_random_uuid(), 'hi') $$,
  null, null, 'outsider cannot post'
);

select * from finish();
rollback;