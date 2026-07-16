// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useMemo } from 'react';
import { AreaChart, Area, XAxis, YAxis, ReferenceDot, ResponsiveContainer } from 'recharts';
import { previewTotalSpark } from 'common/staking';

const PRESET_DAYS = [30, 90, 180, 365, 730];

/**
 * Lock-duration picker with the reward story attached: the boost multiplier
 * (1 + d/365) makes longer locks earn super-linearly, and the curve makes
 * that visible while dragging.
 */
const LockDurationSlider: React.FC<{
  lockDays: number;
  minLockDays: number;
  maxLockDays: number;
  baseRate: number;
  /** Parsed token amount; 0/NaN when the amount field is empty or invalid. */
  tokenAmount: number;
  onChange: (days: number) => void;
}> = ({ lockDays, minLockDays, maxLockDays, baseRate, tokenAmount, onChange }) => {
  const clampedDays = Math.min(Math.max(lockDays || minLockDays, minLockDays), maxLockDays);
  const hasAmount = tokenAmount > 0;
  const boost = 1 + clampedDays / 365;
  const totalSpark = hasAmount ? previewTotalSpark(tokenAmount, clampedDays, baseRate) : 0;
  const sparkPerDay = hasAmount && clampedDays > 0 ? totalSpark / clampedDays : 0;

  const curve = useMemo(() => {
    const points: { d: number; y: number }[] = [];
    const steps = 48;
    for (let i = 0; i <= steps; i++) {
      const d = Math.round(minLockDays + (maxLockDays - minLockDays) * (i / steps));
      points.push({
        d,
        y: hasAmount ? previewTotalSpark(tokenAmount, d, baseRate) : 1 + d / 365,
      });
    }
    return points;
  }, [minLockDays, maxLockDays, baseRate, tokenAmount, hasAmount]);

  const currentY = hasAmount ? totalSpark : boost;

  return <div className='flex flex-col gap-2'>
    <div className='flex items-end justify-between gap-2 flex-wrap'>
      <span className='cg-text-md-500 cg-text-main'>Lock duration</span>
      <div className='flex items-center gap-2'>
        <input
          type='number'
          min={minLockDays}
          max={maxLockDays}
          value={lockDays || ''}
          onChange={e => onChange(Number(e.target.value))}
          className='w-20 text-right cg-bg-subtle cg-border-m px-2 py-1 cg-text-md-500 cg-text-main'
          aria-label='Lock duration in days'
        />
        <span className='cg-text-md-400 cg-text-secondary'>days</span>
      </div>
    </div>

    <input
      type='range'
      min={minLockDays}
      max={maxLockDays}
      step={1}
      value={clampedDays}
      onChange={e => onChange(Number(e.target.value))}
      className='w-full cursor-pointer'
      style={{ accentColor: 'var(--messageMention)' }}
      aria-label='Lock duration slider'
    />
    <div className='flex justify-between'>
      {PRESET_DAYS.filter(d => d >= minLockDays && d <= maxLockDays).map(d => (
        <button
          key={d}
          type='button'
          className={`cg-text-sm-500 ${d === clampedDays ? 'cg-text-brand' : 'cg-text-secondary'} cursor-pointer`}
          onClick={() => onChange(d)}
        >
          {d >= 365 ? `${d / 365}y` : `${d}d`}
        </button>
      ))}
    </div>

    <div className='flex items-center justify-between gap-3 flex-wrap p-3 cg-border-m cg-bg-subtle'>
      <div className='flex flex-col'>
        <span className='cg-text-sm-400 cg-text-secondary'>Reward boost</span>
        <span className='cg-heading-3 cg-text-brand'>×{boost.toFixed(2)}</span>
      </div>
      <div className='flex flex-col'>
        <span className='cg-text-sm-400 cg-text-secondary'>Total Spark</span>
        <span className='cg-heading-3 cg-text-main'>{hasAmount ? totalSpark.toLocaleString('en-US') : '—'}</span>
      </div>
      <div className='flex flex-col'>
        <span className='cg-text-sm-400 cg-text-secondary'>Spark / day</span>
        <span className='cg-heading-3 cg-text-main'>{hasAmount ? Math.floor(sparkPerDay).toLocaleString('en-US') : '—'}</span>
      </div>
    </div>

    <div className='w-full h-32'>
      <ResponsiveContainer width='100%' height='100%'>
        <AreaChart data={curve} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
          <defs>
            <linearGradient id='stakeCurveFill' x1='0' y1='0' x2='0' y2='1'>
              <stop offset='0%' stopColor='var(--messageMention)' stopOpacity={0.45} />
              <stop offset='100%' stopColor='var(--messageMention)' stopOpacity={0.05} />
            </linearGradient>
          </defs>
          <XAxis
            dataKey='d'
            type='number'
            domain={[minLockDays, maxLockDays]}
            ticks={[30, 180, 365, 545, 730].filter(d => d >= minLockDays && d <= maxLockDays)}
            tickFormatter={(d: number) => d >= 365 ? `${(d / 365).toFixed(d % 365 === 0 ? 0 : 1)}y` : `${d}d`}
            tick={{ fontSize: 11, fill: 'var(--text-secondary)' }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis hide domain={['dataMin', 'dataMax']} />
          <Area
            type='monotone'
            dataKey='y'
            stroke='var(--messageMention)'
            strokeWidth={2}
            fill='url(#stakeCurveFill)'
            isAnimationActive={false}
          />
          <ReferenceDot x={clampedDays} y={currentY} r={5} fill='var(--messageMention)' stroke='white' strokeWidth={1.5} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
    <span className='cg-text-sm-400 cg-text-secondary text-center'>
      {hasAmount ? 'Total Spark earned by lock duration' : 'Reward boost by lock duration'} — longer locks earn disproportionately more
    </span>
  </div>;
};

export default LockDurationSlider;
