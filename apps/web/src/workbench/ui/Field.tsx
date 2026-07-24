import React, { useId } from 'react';
import { cx } from './cx';

type FieldControlProps = {
  id?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean | 'true' | 'false';
};

interface FieldProps {
  label: React.ReactNode;
  description?: React.ReactNode;
  error?: React.ReactNode;
  required?: boolean;
  children: React.ReactElement<FieldControlProps>;
  className?: string;
}

export function Field({
  label,
  description,
  error,
  required,
  children,
  className
}: FieldProps): React.ReactElement {
  const id = useId();
  const descriptionId = description ? `${id}-description` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [children.props['aria-describedby'], descriptionId, errorId].filter(Boolean).join(' ') || undefined;
  const controlProps: FieldControlProps = { id: children.props.id ?? id };
  if (describedBy) {
    controlProps['aria-describedby'] = describedBy;
  }
  if (error) {
    controlProps['aria-invalid'] = true;
  } else if (children.props['aria-invalid']) {
    controlProps['aria-invalid'] = children.props['aria-invalid'];
  }
  return (
    <label className={cx('db-field', Boolean(error) && 'db-field--invalid', className)}>
      <span className="db-field__label">{label}{required ? <span aria-hidden="true"> *</span> : null}</span>
      {React.cloneElement(children, controlProps)}
      {description ? <span id={descriptionId} className="db-field__description">{description}</span> : null}
      {error ? <span id={errorId} className="db-field__error">{error}</span> : null}
    </label>
  );
}
