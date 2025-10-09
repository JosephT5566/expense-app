export type CategoryKind = 'expense' | 'income';

export interface CategoryRow {
	id: string; // uuid
	name: string;
	kind: CategoryKind; // expense | income
}
