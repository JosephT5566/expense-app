import type { ReceiptResult } from '$lib/types/expense';

export const mockReceiptResult: ReceiptResult = {
	store_name: '好市多股份有限公司汐止分公司',
	date: '2026-04-18',
	total_amount: 2708,
	currency: 'TWD',
	items: [
		{
			name: '桂格有機燕麥片',
			quantity: 1,
			price: 415
		},
		{
			name: 'IRISWOOZOO循環扇',
			quantity: 1,
			price: 1229
		},
		{
			name: '蚵仔煎洋芋片',
			quantity: 1,
			price: 198
		},
		{
			name: '北海鱈魚香絲600G',
			quantity: 1,
			price: 299
		},
		{
			name: '富士山氣泡水檸檬',
			quantity: 1,
			price: 369
		},
		{
			name: '黑標紅酒瓶售',
			quantity: 1,
			price: 198
		}
	]
};
