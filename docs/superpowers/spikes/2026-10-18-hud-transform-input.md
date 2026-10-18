# HUD transform input spike — findings

Date: 2026-10-18. Probe: a throwaway SDK7 scene (on-screen readout, a box on `CL_PHYSICS`, a generated cube GLB with `visibleMeshesCollisionMask: CL_POINTER`, a continuous `RQT_QUERY_ALL` global-direction raycast from the camera along `PrimaryPointerInfo.worldRayDirection`). Run by the owner in the current Decentraland desktop client. The probe was deleted afterwards.

## SHIFT_ACTION

`SHIFT_ACTION = InputAction.IA_MODIFIER` (value **14**). The owner held Shift and the probe showed `isPressed(IA_MODIFIER) === true`.

- `IA_MODIFIER` exists from **`@dcl/ecs` / `@dcl/sdk` 7.23.0** (absent in 7.22.0; present in 7.23–7.30.1). It is documented in the SDK as "Modifier key (Shift on desktop)".
- `IA_WALK` (9) is **Ctrl** in the current client, not Shift. Do not use it.
- The probe ran on `@dcl/sdk` 7.30.1. Its `sdk-commands` need Node 22 (`fs.globSync`).

## Pointer held

`inputSystem.isPressed(IA_POINTER)` stays true for the whole time the left mouse is held, with the cursor locked (crosshair) and unlocked (free cursor), including after the pointer drags off the item.

## Pointer ray

`PrimaryPointerInfo.getOrNull(engine.RootEntity).worldRayDirection` was present (non-zero) in both cursor modes, so the camera-forward fallback was never used. The owner saw only small changes when aiming across one cube's corners, which is expected (a 1 m cube at about 6 m spans roughly 10°).

**Confirmed later the same day:** with a free cursor the ray follows the mouse (the owner: "the ray definitely changes as i move the pointer around either way"), and with the cursor locked it follows the crosshair.

## Raycast hits

The camera raycast with `collisionMask: CL_POINTER | CL_PHYSICS` hit both the box (physics collider) and the GLB (visible mesh on the pointer layer), in both cursor modes.

## Rulings for the build

- The workspace resolves `@dcl/sdk` 7.22.0, whose typings lack `IA_MODIFIER`. Rather than re-resolve the `@dcl/*` tree (lockfile churn), the adapter defines `SHIFT_ACTION = 14 as InputAction` in one place, with a comment pointing here.
- `vlm-dcl` and `vlm-adapter-dcl` raise their `@dcl/sdk` peer floor to `>=7.23.0` in the release that ships these tools (Task 8). The in-world checklist runs in a test scene on SDK ≥ 7.23.
