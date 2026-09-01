ALTER TABLE "staff_roles" ADD COLUMN "is_system_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "staff_roles" SET "is_system_admin" = true WHERE "name" = 'Administrator';--> statement-breakpoint
UPDATE "staff_roles" r SET "is_system_admin" = true
WHERE NOT EXISTS (SELECT 1 FROM "staff_roles" WHERE "is_system_admin")
  AND EXISTS (
    SELECT 1 FROM "staff_role_permissions" p
    WHERE p."role_id" = r."id" AND p."permission_key" = 'employee.manage'
  )
  AND EXISTS (
    SELECT 1 FROM "staff_role_permissions" p
    WHERE p."role_id" = r."id" AND p."permission_key" = 'permission.manage'
  );
