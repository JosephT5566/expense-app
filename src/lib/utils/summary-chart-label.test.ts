import { expect, it } from 'vitest';
import { summaryChartLabel } from './summary-chart-label';

it('includes the center total and each positive category amount and percentage', () => {
	expect(
		summaryChartLabel([
			{ label: '合成餐飲', value: 300 },
			{ label: '合成交通', value: 100 },
			{ label: '零額', value: 0 }
		])
	).toBe('本月各類別花費佔比圖，總計 400：合成餐飲 300（75%）、合成交通 100（25%）');
});
it('rounds percentages independently to one decimal place', () => {
	expect(
		summaryChartLabel([
			{ label: 'a', value: 1 },
			{ label: 'b', value: 2 }
		])
	).toBe('本月各類別花費佔比圖，總計 3：a 1（33.3%）、b 2（66.7%）');
});
it('handles empty and non-positive totals, retaining the chart total for mixed signs', () => {
	expect(summaryChartLabel([])).toBe('本月各類別花費佔比圖，總計 0');
	expect(summaryChartLabel([{ label: 'a', value: 0 }])).toBe('本月各類別花費佔比圖，總計 0');
	expect(
		summaryChartLabel([
			{ label: 'a', value: 100 },
			{ label: 'b', value: -20 }
		])
	).toBe('本月各類別花費佔比圖，總計 80：a 100（125%）');
});
