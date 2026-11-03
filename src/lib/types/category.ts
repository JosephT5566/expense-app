export type CategoryKind = 'expense' | 'income';

export interface CategoryRow {
	id: string; // uuid
	name: string;
	sort_order?: number; // select(*) includes the database ordering column
	kind: CategoryKind; // expense | income
}
