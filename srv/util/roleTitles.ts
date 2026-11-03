// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { PredefinedRole } from "../common/enums";

const reservedRoleTitles = new Set(Object.values(PredefinedRole).map(title => title.toLowerCase()));

/**
 * Whether `title` is the title of a predefined role (Admin, Member, Public)
 * in any letter case and with surrounding spaces. A custom role cannot take
 * one; a custom role that carries one from before keeps it.
 */
export function isReservedRoleTitle(title: string): boolean {
  return reservedRoleTitles.has(title.trim().toLowerCase());
}
