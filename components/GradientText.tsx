import React from 'react';
import './GradientText.css';

interface GradientTextProps {
  children: React.ReactNode;
  className?: string;
  colors?: string[];
  animationSpeed?: number;
}

export const GradientText: React.FC<GradientTextProps> = ({
  children,
  className = "",
  colors = ["#2563eb", "#60a5fa", "#7c3aed", "#2563eb"], 
  animationSpeed = 8,
}) => {
  const gradientStyle = {
    backgroundImage: `linear-gradient(to right, ${colors.join(", ")})`,
    animationDuration: `${animationSpeed}s`,
  };

  return (
    <span className={`animated-gradient-text ${className}`} style={gradientStyle}>
      {children}
    </span>
  );
};