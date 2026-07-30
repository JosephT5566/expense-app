import type { ReceiptAnalysisResult } from '$lib/types/expense';

export const mockReceiptResult: ReceiptAnalysisResult = {
	document_type: 'receipt',
	receipt: {
		merchant: {
			state: 'recognized',
			value: { name: '好市多股份有限公司汐止分公司' }
		},
		purchase_date: { state: 'recognized', value: '2026-04-18' },
		totals: { state: 'recognized', value: { grand_total: '1644.00' } },
		currency: { state: 'recognized', value: 'TWD' },
		line_items: {
			state: 'recognized',
			value: [
				{
					description: { state: 'recognized', value: '桂格有機燕麥片' },
					quantity: { state: 'recognized', value: '1' },
					unit_price: { state: 'recognized', value: '415.00' },
					line_total: { state: 'recognized', value: '415.00' }
				},
				{
					description: { state: 'recognized', value: 'IRISWOOZO循環扇' },
					quantity: { state: 'recognized', value: '1' },
					unit_price: { state: 'recognized', value: '1229.00' },
					line_total: { state: 'recognized', value: '1229.00' }
				}
			]
		}
	}
};
