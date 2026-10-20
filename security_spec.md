# DukaanDesk — Firestore Security Specification (Phase 0 TDD)

## 1. Data Invariants

1. **Tenant Isolation & Master Gate Invariant**:
   - Every shop document `/shops/{shopId}` has an immutable `ownerUid` matching `request.auth.uid` upon creation.
   - Every subcollection document under `/shops/{shopId}/{subcollection}/{docId}` (`products`, `stockAdjustments`, `sales`, `expenses`, `receiptDeliveries`, `counters`) must belong to a valid parent `/shops/{shopId}` whose `ownerUid == request.auth.uid`, and the document's own `ownerUid` and `shopId` fields must match `request.auth.uid` and `shopId`.
   - For `list` queries on subcollections, `resource.data.ownerUid == request.auth.uid && resource.data.shopId == shopId` is enforced directly on `resource.data` without `get()` calls to prevent $O(N)$ read amplification while guaranteeing zero cross-shop leakage.

2. **Schema & Anti-Update-Gap Invariant**:
   - Every `create` and `update` operation calls `isValid[Entity](incoming())` enforcing strict key allowlists (`keys().hasAll(...) && keys().hasOnly(...)`), string length bounds (`.size() <= MAX`), numeric non-negativity, and enum membership.
   - Every `update` block begins with `isValid[Entity](incoming())` and restricts mutated keys with `incoming().diff(existing()).affectedKeys().hasOnly(...)`.

3. **Terminal State & Immutable Audit Invariant**:
   - `Sale` documents created with `status == 'COMPLETED'` can only transition to `status == 'REVERSED'`. Once `existing().status == 'REVERSED'`, any further update is permanently rejected (Terminal State Lock).
   - `StockAdjustment` documents are append-only audit logs (`allow update, delete: if false;`).
   - `createdAt`, `ownerUid`, `shopId`, and `id` are immortal fields that cannot be altered after creation.

4. **Temporal Integrity Invariant**:
   - All server timestamp fields (`createdAt`, `updatedAt`) must equal `request.time`.

---

## 2. The "Dirty Dozen" Adversarial Payloads

1. **Payload 1 (Identity Spoofing on Shop Creation)**:
   - Path: `/shops/shop-1`
   - Action: `create` as `user_A` with `ownerUid: "user_B"`.
   - Expected: `PERMISSION_DENIED` (`incoming().ownerUid == request.auth.uid` fails).

2. **Payload 2 (Cross-Tenant Product Read/List)**:
   - Path: `/shops/shop_B/products/prod-1`
   - Action: `get` or `list` as `user_A` where `ownerUid == "user_B"`.
   - Expected: `PERMISSION_DENIED`.

3. **Payload 3 (Shadow Field Injection on Product Update)**:
   - Path: `/shops/shop_A/products/prod-1`
   - Action: `update` adding unauthorized field `isSuperFeatured: true`.
   - Expected: `PERMISSION_DENIED` (`keys().hasOnly(...)` and `affectedKeys().hasOnly(...)` reject ghost fields).

4. **Payload 4 (Negative Price / Negative Stock Injection)**:
   - Path: `/shops/shop_A/products/prod-1`
   - Action: `create` with `pricePaise: -500` or `stock: -10`.
   - Expected: `PERMISSION_DENIED` (`pricePaise >= 0 && stock >= 0` fails).

5. **Payload 5 (ID Poisoning / Oversized Path Variable)**:
   - Path: `/shops/shop_A/products/invalid$id!with*spaces`
   - Action: `create` with malformed document ID.
   - Expected: `PERMISSION_DENIED` (`isValidId(productId)` regex guard fails).

6. **Payload 6 (Denial-of-Wallet 1MB String Payload)**:
   - Path: `/shops/shop_A/expenses/exp-1`
   - Action: `create` with `notes` containing 10,000 characters.
   - Expected: `PERMISSION_DENIED` (`notes.size() <= 240` fails).

7. **Payload 7 (Terminal State Bypass on Reversed Sale)**:
   - Path: `/shops/shop_A/sales/INV-20261019-001`
   - Action: `update` a sale whose `existing().status == 'REVERSED'` back to `'COMPLETED'`.
   - Expected: `PERMISSION_DENIED` (Terminal state lock `existing().status == 'COMPLETED'` fails).

8. **Payload 8 (Sale Line-Item Array Bomb)**:
   - Path: `/shops/shop_A/sales/INV-20261019-002`
   - Action: `create` with `items: []` (empty) or > 100 items.
   - Expected: `PERMISSION_DENIED` (`items.size() >= 1 && items.size() <= 100` fails).

9. **Payload 9 (Immortal Field Mutation on Product)**:
   - Path: `/shops/shop_A/products/prod-1`
   - Action: `update` attempting to change `ownerUid`, `shopId`, or `createdAt`.
   - Expected: `PERMISSION_DENIED` (`incoming().ownerUid == existing().ownerUid` and `affectedKeys()` fail).

10. **Payload 10 (Forged Client Timestamp)**:
    - Path: `/shops/shop_A/expenses/exp-2`
    - Action: `create` with `createdAt` set to a past timestamp instead of `request.time`.
    - Expected: `PERMISSION_DENIED` (`incoming().createdAt == request.time` fails).

11. **Payload 11 (Stock Adjustment Audit Tampering)**:
    - Path: `/shops/shop_A/stockAdjustments/adj-1`
    - Action: `update` or `delete` an existing stock adjustment audit record.
    - Expected: `PERMISSION_DENIED` (`allow update, delete: if false`).

12. **Payload 12 (PII Blanket Read on `/users/{userId}`)**:
    - Path: `/users/user_B`
    - Action: `get` or `list` as `user_A`.
    - Expected: `PERMISSION_DENIED` (`userId == request.auth.uid` enforced).
