/** Use the same total as the chart's center text, omitting non-positive segments.
 * Percentages use that total and round independently to one decimal place.
 */
export function summaryChartLabel(data: readonly { label: string; value: number }[]): string {
	const total = data.reduce((sum, { value }) => sum + value, 0);
	const parts = data
		.filter(({ value }) => value > 0)
		.map(
			({ label, value }) =>
				`${label} ${value}（${total > 0 ? Math.round((value / total) * 1000) / 10 : 0}%）`
		);
	return `本月各類別花費佔比圖，總計 ${total}${parts.length ? `：${parts.join('、')}` : ''}`;
}
