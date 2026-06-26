import React from 'react';
import { X } from 'lucide-react';
import { IconButton, type IconButtonProps } from './IconButton';
import { cx } from './cx';

export type CloseButtonProps = Omit<IconButtonProps, 'icon'>;

export function CloseButton({
  className,
  ...props
}: CloseButtonProps): React.ReactElement {
  return (
    <IconButton
      {...props}
      className={cx('db-workbench-close-button', className)}
      icon={<X size={10} />}
    />
  );
}
