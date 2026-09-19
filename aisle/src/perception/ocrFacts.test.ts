import { ocrFactTokens } from './ocrFacts';
const read = (text: string, confidence = 0.9) => ({ text, confidence, box: [0.2, 0.1, 0.2, 0.1] as [number, number, number, number], timestamp: 0 });

it('drops captured kitchen noise without losing a store aisle number', () => {
  const noise = ['1', 'JI', 'II', 'TJL', 'RI'].map((t) => read(t));
  expect(ocrFactTokens(noise, false)).toEqual([]);
  expect(ocrFactTokens([read('1'), read('DAIRY')], true)).toEqual(['1', 'DAIRY']);
});

it('rejects weak readings and price tags; accepts known short store signs', () => {
  expect(ocrFactTokens([read('DAIRY', 0.3), read('1', 0.7), read('$4.99'), read('RX')], true, ['RX'])).toEqual(['RX']);
});
