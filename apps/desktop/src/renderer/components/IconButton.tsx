import type { ComponentProps, ReactNode } from 'react'

type IconButtonProps = ComponentProps<'button'> & {
  label: string
  children: ReactNode
}

export function IconButton({ label, children, className = '', ...props }: IconButtonProps) {
  return (
    <span className="icon-button-wrap">
      <button type="button" aria-label={label} className={`icon-button ${className}`} {...props}>
        {children}
      </button>
      <span className="control-tooltip" role="tooltip">{label}</span>
    </span>
  )
}