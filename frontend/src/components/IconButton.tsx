import type { ButtonHTMLAttributes } from 'react'
import { Icon, type IconName } from './Icon'

type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  icon: IconName
  /** Accessible name; also used as the tooltip. */
  label: string
  /** Render the label next to the icon instead of icon-only. */
  showLabel?: boolean
  primary?: boolean
  active?: boolean
  feedback?: boolean
  busy?: boolean
  size?: 'sm' | 'md'
}

export function IconButton({
  icon,
  label,
  showLabel = false,
  primary = false,
  active = false,
  feedback = false,
  busy = false,
  size = 'md',
  className,
  disabled,
  type = 'button',
  ...rest
}: IconButtonProps) {
  const classes = [
    'icon-button',
    `icon-button-${size}`,
    primary ? 'is-primary' : '',
    active ? 'is-active' : '',
    feedback ? 'save-feedback' : '',
    busy ? 'is-busy' : '',
    showLabel ? 'has-label' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button
      type={type}
      className={classes}
      aria-label={label}
      title={label}
      aria-pressed={active || undefined}
      disabled={disabled || busy}
      {...rest}
    >
      <Icon name={busy ? 'spinner' : icon} size={size === 'sm' ? 16 : 18} />
      {showLabel ? <span className="icon-button-label">{label}</span> : null}
    </button>
  )
}
